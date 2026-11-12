from pathlib import Path
import json
import threading
import time
from collections import defaultdict, deque

from dotenv import load_dotenv
from openai import (
    APIConnectionError,
    APITimeoutError,
    AuthenticationError,
    OpenAI,
    PermissionDeniedError,
    RateLimitError,
)
import os
import re
import sys
from datetime import datetime, timezone, timedelta

import pandas as pd
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from pymongo import MongoClient
from pymongo.errors import DuplicateKeyError
from passlib.context import CryptContext
from bson import ObjectId
from bson.errors import InvalidId
from jose import JWTError, jwt
from jose.exceptions import ExpiredSignatureError

DEPLOYMENT_DIR = Path(__file__).resolve().parent
load_dotenv(DEPLOYMENT_DIR / ".env")

if str(DEPLOYMENT_DIR) not in sys.path:
    sys.path.insert(0, str(DEPLOYMENT_DIR))

# Use the new saved preseason ML pipelines.
from preseason_prediction_service import (
    get_prediction,
    get_prediction_options,
)

# All-district summaries for the dashboard overview.
from dashboard_overview import build_overview

# Helpers that build the AI context and validate the model's JSON output.
from dashboard_insights import (
    InsightValidationError,
    build_chat_messages,
    language_rule,
    build_explain_messages,
    build_insight_context,
    build_messages,
    build_repair_messages,
    check_figures,
    compact_chat_context,
    has_analysable_data,
    parse_and_validate,
    question_mentions_dashboard,
    shared_figure_clusters,
    render_markdown,
    statewide_associations,
)

# Database settings
MONGO_URI = os.getenv(
    "MONGO_URI",
    "mongodb://localhost:27017/",
)
DB_NAME = "crop_analysis"

JWT_SECRET = os.getenv(
    "JWT_SECRET",
    "local-development-only-change-this-secret-before-deployment",
)
JWT_ALGORITHM = "HS256"
TOKEN_EXPIRE_MINUTES = 60

password_context = CryptContext(
    schemes=["bcrypt"],
    deprecated="auto",
)

app = FastAPI(
    title="Crop Yield Prediction API",
    description=(
        "Experimental preseason ML yield estimates for Rice and Dry chillies "
        "in Andhra Pradesh. Weather timing assumptions and provenance "
        "have not yet been independently verified."
    ),
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["Content-Type", "Authorization"],
)


# -------------------- Request models --------------------
class DashboardInsightRequest(BaseModel):
    district_a: str = Field(min_length=1, max_length=100)
    district_b: str = Field(min_length=1, max_length=100)
    crop: str = Field(min_length=1, max_length=100)
    season: str = Field(min_length=1, max_length=100)
    year: int = Field(ge=1997, le=2014)
    language: str = Field(default="English", max_length=20)


class RegisterRequest(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    email: str = Field(min_length=5, max_length=254)
    password: str = Field(min_length=8, max_length=72)
    # Optional details from the sign-up form. Old clients simply leave them out.
    phone: str | None = Field(default=None, max_length=30)
    age: int | None = Field(default=None, ge=1, le=120)
    college: str | None = Field(default=None, max_length=120)


class LoginRequest(BaseModel):
    email: str = Field(min_length=5, max_length=254)
    password: str = Field(min_length=1, max_length=72)


class PredictionRequest(BaseModel):
    district: str = Field(min_length=1)
    crop: str = Field(min_length=1)
    season: str = Field(min_length=1)
    year: int = Field(ge=2011, le=2014)


# -------------------- Database helpers --------------------


def get_database():
    client = MongoClient(
        MONGO_URI,
        serverSelectionTimeoutMS=5000,
    )
    return client, client[DB_NAME]


def normalize_email(email: str) -> str:
    email = email.strip().lower()

    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        raise HTTPException(
            status_code=422,
            detail="Please enter a valid email address.",
        )

    return email


PHONE_PATTERN = re.compile(r"^[+()\-\s\d]{7,20}$")


def clean_phone(value):
    """A tidy phone number, or None when it was left empty."""
    phone = (value or "").strip()
    if not phone:
        return None
    if not PHONE_PATTERN.fullmatch(phone):
        raise HTTPException(
            status_code=422,
            detail="Enter a valid phone number, or leave it empty.",
        )
    return phone


def current_user(authorization: str | None = Header(default=None)):
    """Who is signed in, from the login token sent with the request."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Please sign in to continue.")
    token = authorization[7:].strip()
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except ExpiredSignatureError:
        raise HTTPException(
            status_code=401,
            detail="Your session has ended. Please sign in again.",
        )
    except JWTError:
        raise HTTPException(status_code=401, detail="Please sign in again.")
    try:
        return {"id": ObjectId(payload["sub"]), "email": payload.get("email")}
    except (KeyError, InvalidId, TypeError):
        raise HTTPException(status_code=401, detail="Please sign in again.")


def profile_payload(user):
    created = user.get("createdAt")
    if created is not None and created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    return {
        "id": str(user["_id"]),
        "name": user.get("name", ""),
        "email": user.get("email", ""),
        "phone": user.get("phone"),
        "age": user.get("age"),
        "college": user.get("college"),
        "memberSince": created.isoformat() if created else None,
    }


def create_access_token(user_id: str, email: str) -> str:
    now = datetime.now(timezone.utc)

    payload = {
        "sub": user_id,
        "email": email,
        "iat": now,
        "exp": now + timedelta(minutes=TOKEN_EXPIRE_MINUTES),
    }

    return jwt.encode(
        payload,
        JWT_SECRET,
        algorithm=JWT_ALGORITHM,
    )


# -------------------- Rate limits (kept low to protect the AI quota) --------------------

# (requests allowed, window in seconds). Sign-in and data pages are not limited.
RATE_LIMITS = {
    "chat": (10, 60),  # quick questions
    "heavy": (4, 60),  # explain and insights: longer answers, more tokens
}
_hits = defaultdict(deque)
_hits_lock = threading.Lock()


def _limit_key(request: Request):
    """The signed-in person when there is a valid login, otherwise the network address.

    Keying by person means students sharing one college connection each get
    their own allowance.
    """
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        try:
            payload = jwt.decode(
                auth[7:].strip(), JWT_SECRET, algorithms=[JWT_ALGORITHM]
            )
            return f"user:{payload['sub']}"
        except Exception:
            pass
    return f"ip:{request.client.host if request.client else 'unknown'}"


def enforce_rate_limit(request: Request, bucket: str):
    limit, window = RATE_LIMITS[bucket]
    who = _limit_key(request)
    now = time.monotonic()
    with _hits_lock:
        recent = _hits[(bucket, who)]
        while recent and now - recent[0] > window:
            recent.popleft()
        if len(recent) >= limit:
            wait = int(window - (now - recent[0])) + 1
            raise HTTPException(
                status_code=429,
                detail=f"You have asked a lot in a short time. Please wait about {wait} seconds and try again.",
            )
        recent.append(now)


# -------------------- Health check --------------------


@app.get("/")
def home():
    return {
        "message": "Crop Yield Prediction API is running",
        "primary_method": "Preseason ML pipeline (experimental)",
        "supported_crops": ["Rice", "Dry chillies"],
        "supported_prediction_years": [2011, 2012, 2013, 2014],
        "documentation": "/docs",
    }


# -------------------- Registration --------------------


@app.post("/register", status_code=201)
def register(request: RegisterRequest):
    name = request.name.strip()

    if len(name) < 2:
        raise HTTPException(
            status_code=422,
            detail="Please enter your name.",
        )

    email = normalize_email(request.email)

    if len(request.password.encode("utf-8")) > 72:
        raise HTTPException(
            status_code=422,
            detail="Password must be no longer than 72 bytes.",
        )

    password_hash = password_context.hash(request.password)
    client = None

    try:
        client, db = get_database()
        client.admin.command("ping")

        db["users"].create_index("email", unique=True)

        user = {
            "name": name,
            "email": email,
            "passwordHash": password_hash,
            "createdAt": datetime.now(timezone.utc),
        }
        # Keep the optional details only when the person filled them in.
        phone = clean_phone(request.phone)
        college = (request.college or "").strip()
        if phone:
            user["phone"] = phone
        if request.age is not None:
            user["age"] = request.age
        if college:
            user["college"] = college

        result = db["users"].insert_one(user)

        return {
            "message": "Registration successful. Please log in.",
            "user": {
                "id": str(result.inserted_id),
                "name": name,
                "email": email,
            },
        }

    except DuplicateKeyError:
        raise HTTPException(
            status_code=409,
            detail="An account with this email already exists.",
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail="Could not register right now. Please try again.",
        ) from exc
    finally:
        if client is not None:
            client.close()


# -------------------- Login --------------------


@app.post("/login")
def login(request: LoginRequest):
    email = normalize_email(request.email)
    client = None

    try:
        client, db = get_database()
        client.admin.command("ping")

        user = db["users"].find_one({"email": email})

        if user is None or not password_context.verify(
            request.password,
            user["passwordHash"],
        ):
            raise HTTPException(
                status_code=401,
                detail="Incorrect email or password.",
            )

        token = create_access_token(
            str(user["_id"]),
            user["email"],
        )

        return {
            "message": "Login successful.",
            "access_token": token,
            "token_type": "bearer",
            "expires_in": TOKEN_EXPIRE_MINUTES * 60,
            "user": {
                "id": str(user["_id"]),
                "name": user["name"],
                "email": user["email"],
            },
        }

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail="Could not log in right now. Please try again.",
        ) from exc
    finally:
        if client is not None:
            client.close()


# -------------------- Profile --------------------


class ProfileUpdate(BaseModel):
    # Only the details that are sent get changed. The email cannot be changed here.
    name: str | None = Field(default=None, max_length=100)
    phone: str | None = Field(default=None, max_length=30)
    age: int | None = Field(default=None, ge=1, le=120)
    college: str | None = Field(default=None, max_length=120)


def load_user(db, who):
    user = db["users"].find_one({"_id": who["id"]})
    if user is None:
        raise HTTPException(status_code=401, detail="Please sign in again.")
    return user


@app.get("/profile")
def get_profile(who=Depends(current_user)):
    client = None
    try:
        client, db = get_database()
        client.admin.command("ping")
        return profile_payload(load_user(db, who))
    except HTTPException:
        raise
    except Exception as exc:
        print(f"Profile could not be loaded: {type(exc).__name__}: {exc}")
        raise HTTPException(
            status_code=503,
            detail="We could not load your profile right now. Please try again.",
        ) from exc
    finally:
        if client is not None:
            client.close()


@app.patch("/profile")
def update_profile(update: ProfileUpdate, who=Depends(current_user)):
    sent = update.model_fields_set
    changes, removals = {}, {}

    if "name" in sent:
        name = (update.name or "").strip()
        if len(name) < 2:
            raise HTTPException(status_code=422, detail="Please enter your name.")
        changes["name"] = name
    if "phone" in sent:
        phone = clean_phone(update.phone)
        if phone:
            changes["phone"] = phone
        else:
            removals["phone"] = ""
    if "age" in sent:
        if update.age is None:
            removals["age"] = ""
        else:
            changes["age"] = update.age
    if "college" in sent:
        college = (update.college or "").strip()
        if college:
            changes["college"] = college
        else:
            removals["college"] = ""

    client = None
    try:
        client, db = get_database()
        client.admin.command("ping")
        load_user(db, who)

        operations = {}
        if changes:
            operations["$set"] = changes
        if removals:
            operations["$unset"] = removals
        if operations:
            db["users"].update_one({"_id": who["id"]}, operations)

        return profile_payload(load_user(db, who))
    except HTTPException:
        raise
    except Exception as exc:
        print(f"Profile could not be saved: {type(exc).__name__}: {exc}")
        raise HTTPException(
            status_code=503,
            detail="We could not save your details right now. Please try again.",
        ) from exc
    finally:
        if client is not None:
            client.close()


# -------------------- Preseason ML prediction --------------------


@app.post("/predict")
def predict(request: PredictionRequest):
    client = None

    try:
        result = get_prediction(
            district=request.district,
            crop=request.crop,
            season=request.season,
            year=request.year,
        )

        if result is None:
            raise HTTPException(
                status_code=422,
                detail="Prediction is unavailable for these selections.",
            )

        # Keep a history of estimates, but never lose the estimate itself if
        # the history cannot be saved.
        try:
            client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=1500)
            db = client[DB_NAME]
            client.admin.command("ping")

            document = dict(result)
            document["requestedAt"] = datetime.now(timezone.utc)

            db["prediction_history"].insert_one(document)
        except Exception as history_problem:
            print(f"Prediction history was not saved: {history_problem}")

        return result

    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail=str(exc),
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail="We could not work out the estimate right now. Please try again.",
        ) from exc
    finally:
        if client is not None:
            client.close()


# -------------------- ML prediction options --------------------


@app.get("/predict/options")
def prediction_options():
    """Return all supported ML prediction selections."""
    try:
        options = get_prediction_options()

        return {
            "crops": sorted(options["Crop"].dropna().unique().tolist()),
            "districts": sorted(options["District_Name"].dropna().unique().tolist()),
            "seasons": sorted(options["Season"].dropna().unique().tolist()),
            "years": sorted(
                options["Crop_Year"].dropna().astype(int).unique().tolist()
            ),
            "combinations": options.to_dict(orient="records"),
        }
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail="We could not load the options right now. Please refresh the page.",
        ) from exc


# -------------------- Historical evaluation --------------------

EVALUATION_CSV = (
    DEPLOYMENT_DIR.parent
    / "02_Integrated_Data"
    / "Stage10_Crop_Specific_Ridge_Predictions.csv"
)


@app.get("/evaluation/options")
def evaluation_options():
    """Return available historical evaluation filters."""

    if not EVALUATION_CSV.exists():
        raise HTTPException(
            status_code=503,
            detail="Historical evaluation data is unavailable.",
        )

    try:
        df = pd.read_csv(EVALUATION_CSV)

        return {
            "crops": sorted(df["Crop"].dropna().unique().tolist()),
            "districts": sorted(df["District_Name"].dropna().unique().tolist()),
            "seasons": sorted(df["Season"].dropna().unique().tolist()),
            "years": sorted(df["Crop_Year"].dropna().astype(int).unique().tolist()),
        }
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail="Could not read historical evaluation data.",
        ) from exc


@app.get("/evaluation")
def historical_evaluation(
    crop: str,
    district: str,
    season: str,
    year: int,
):
    """Return a stored historical holdout result, not a new forecast."""

    if year not in range(2011, 2015):
        raise HTTPException(
            status_code=422,
            detail="Choose a historical test year from 2011 to 2014.",
        )

    if not EVALUATION_CSV.exists():
        raise HTTPException(
            status_code=503,
            detail="Historical evaluation data is unavailable.",
        )

    try:
        df = pd.read_csv(EVALUATION_CSV)

        matches = df[
            (df["Crop"].astype(str).str.casefold() == crop.strip().casefold())
            & (
                df["District_Name"].astype(str).str.casefold()
                == district.strip().casefold()
            )
            & (df["Season"].astype(str).str.casefold() == season.strip().casefold())
            & (pd.to_numeric(df["Crop_Year"], errors="coerce") == year)
        ]

        if matches.empty:
            raise HTTPException(
                status_code=404,
                detail=(
                    "No historical evaluation result exists " "for these selections."
                ),
            )

        row = matches.iloc[0]
        actual = float(row["Actual"])
        predicted = float(row["Ridge_Pred"])

        return {
            "crop": str(row["Crop"]),
            "district": str(row["District_Name"]),
            "season": str(row["Season"]),
            "year": int(row["Crop_Year"]),
            "actual_yield_kg_ha": actual,
            "predicted_yield_kg_ha": predicted,
            "absolute_error_kg_ha": abs(actual - predicted),
            "evaluation_type": "Historical holdout result (Ridge model)",
        }

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail="Could not retrieve the historical evaluation result.",
        ) from exc


# -------------------- Dashboard historical data --------------------

DASHBOARD_CSV = (
    DEPLOYMENT_DIR.parent
    / "02_Integrated_Data"
    / "Crop_Weather_Soil_Integrated_1997_2014.csv"
)

# Area is in hectares and Production in tonnes, so Production * 1000 / Area
# is kg/ha. unit_check() confirms that the stored yield column agrees.
DASHBOARD_UNITS = {
    "area": "hectares",
    "production": "tonnes",
    "yield": "kg/ha",
}

# The comparison values for one district-year. Two source rows only count as
# the same record when these three values agree.
CORE_VALUE_COLUMNS = ["Area", "Production", "Yield_kg_ha"]


def strip_text_columns(df, columns=("District_Name", "Crop", "Season")):
    """Remove stray spaces (the source stores seasons as "Kharif ")."""
    for col in columns:
        if col in df.columns:
            df[col] = df[col].astype("string").str.strip()
    return df


def unit_check(df):
    """How many rows have Yield_kg_ha == Production * 1000 / Area."""
    values = df[CORE_VALUE_COLUMNS].apply(pd.to_numeric, errors="coerce").dropna()
    values = values[values["Area"] > 0]
    derived = values["Production"] * 1000 / values["Area"]
    tolerance = (values["Yield_kg_ha"].abs() * 0.001).clip(lower=0.01)
    consistent = (derived - values["Yield_kg_ha"]).abs() <= tolerance
    return {
        "rows_checked": int(len(values)),
        "rows_consistent": int(consistent.sum()),
    }


def resolve_single_record(rows):
    """Pick the one row for a district-year without guessing.

    Returns (row or None, status). Exact repeats of the same values are
    collapsed. Rows that disagree are not resolved: the record is reported as
    conflicting instead of silently using whichever row comes first.
    """
    if rows.empty:
        return None, "no_record"
    if len(rows) == 1:
        return rows.iloc[0], "single_record"
    distinct = rows[CORE_VALUE_COLUMNS].round(6).drop_duplicates()
    if len(distinct) == 1:
        return rows.iloc[0], "identical_duplicates_collapsed"
    return None, "conflicting_rows_not_used"


@app.get("/dashboard/summary")
def dashboard_summary():
    """Return verified historical crop summaries for the Dashboard."""

    if not DASHBOARD_CSV.exists():
        raise HTTPException(
            status_code=503,
            detail="Dashboard historical data is unavailable.",
        )

    try:
        df = pd.read_csv(DASHBOARD_CSV)

        required = [
            "Crop",
            "District_Name",
            "Season",
            "Crop_Year",
            "Area",
            "Production",
            "Yield_kg_ha",
        ]

        missing = [column for column in required if column not in df.columns]
        if missing:
            raise HTTPException(
                status_code=500,
                detail="Dashboard dataset is missing required columns.",
            )

        strip_text_columns(df)
        df["Crop_Year"] = pd.to_numeric(df["Crop_Year"], errors="coerce")
        df["Yield_kg_ha"] = pd.to_numeric(df["Yield_kg_ha"], errors="coerce")

        valid = df.dropna(
            subset=["Crop", "District_Name", "Season", "Crop_Year", "Yield_kg_ha"]
        ).copy()

        yearly = (
            valid.groupby(["Crop_Year", "Crop"], as_index=False)
            .agg(
                average_yield_kg_ha=("Yield_kg_ha", "mean"),
                records=("Yield_kg_ha", "count"),
            )
            .sort_values(["Crop_Year", "Crop"])
        )

        district = (
            valid.groupby(["District_Name", "Crop"], as_index=False)
            .agg(
                average_yield_kg_ha=("Yield_kg_ha", "mean"),
                records=("Yield_kg_ha", "count"),
            )
            .sort_values(["Crop", "District_Name"])
        )

        # Years that have at least one district record, per crop and season,
        # so the year filter can mark years with no data.
        coverage = [
            {
                "crop": str(crop_name),
                "season": str(season_name),
                "years": sorted(int(y) for y in group["Crop_Year"].unique()),
            }
            for (crop_name, season_name), group in valid.groupby(["Crop", "Season"])
        ]

        units_checked = unit_check(valid)

        return {
            "data_source": DASHBOARD_CSV.name,
            "period": {
                "start_year": int(valid["Crop_Year"].min()),
                "end_year": int(valid["Crop_Year"].max()),
            },
            "record_count": int(len(valid)),
            "crops": sorted(valid["Crop"].unique().tolist()),
            "districts": sorted(valid["District_Name"].unique().tolist()),
            "seasons": sorted(valid["Season"].unique().tolist()),
            "coverage": coverage,
            "yearly_summary": yearly.to_dict(orient="records"),
            "district_summary": district.to_dict(orient="records"),
            "yield_unit": "kg/ha",
            "units": DASHBOARD_UNITS,
            "unit_check": units_checked,
            "yield_status_note": (
                f"Yield equals Production x 1000 / Area in "
                f"{units_checked['rows_consistent']} of "
                f"{units_checked['rows_checked']} rows, consistent with area in "
                "hectares, production in tonnes and yield in kg/ha."
            ),
        }

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail="Could not generate Dashboard historical summaries.",
        ) from exc


# -------------------- Dashboard district comparison --------------------


@app.get("/dashboard/compare")
def dashboard_compare(
    district_a: str,
    district_b: str,
    crop: str,
    season: str,
    year: int,
):
    """Compare two districts using observed historical records."""

    if not DASHBOARD_CSV.exists():
        raise HTTPException(
            status_code=503,
            detail="Dashboard historical data is unavailable.",
        )

    try:
        df = pd.read_csv(DASHBOARD_CSV)

        required = [
            "District_Name",
            "Crop_Year",
            "Season",
            "Crop",
            "Area",
            "Production",
            "Yield_kg_ha",
        ]
        missing = [col for col in required if col not in df.columns]

        if missing:
            raise HTTPException(
                status_code=500,
                detail="Dashboard dataset is missing required columns.",
            )

        # Normalize text values for reliable filtering.
        strip_text_columns(df)

        df["Crop_Year"] = pd.to_numeric(df["Crop_Year"], errors="coerce")

        numeric_columns = [
            "Area",
            "Production",
            "Yield_kg_ha",
            "Weather_Rainfall_mm",
            "Weather_Mean_Temperature_C",
            "Weather_Min_Temperature_C",
            "Weather_Max_Temperature_C",
            "Weather_Relative_Humidity_pct",
            "Weather_Solar_Radiation_MJ_m2_day",
            "Weather_ET0_mm",
            "Soil_Soil_pH_H2O_0_5cm",
            "Soil_Organic_Carbon_g_per_kg_0_5cm",
            "Soil_Total_Nitrogen_g_per_kg_0_5cm",
            "Soil_Clay_pct_0_5cm",
            "Soil_Sand_pct_0_5cm",
            "Soil_Silt_pct_0_5cm",
            "Soil_CEC_cmol_per_kg_0_5cm",
            "Soil_Bulk_Density_kg_per_dm3_0_5cm",
        ]

        for col in numeric_columns:
            if col in df.columns:
                df[col] = pd.to_numeric(df[col], errors="coerce")

        district_a = district_a.strip().upper()
        district_b = district_b.strip().upper()
        crop = crop.strip().casefold()
        season = season.strip().casefold()

        if district_a == district_b:
            raise HTTPException(
                status_code=400,
                detail="Please select two different districts.",
            )

        if year < 1997 or year > 2014:
            raise HTTPException(
                status_code=400,
                detail="Historical comparison supports years 1997–2014.",
            )

        valid_crops = {
            value.casefold(): value for value in df["Crop"].dropna().unique()
        }
        valid_seasons = {
            value.casefold(): value for value in df["Season"].dropna().unique()
        }
        valid_districts = {
            value.upper(): value for value in df["District_Name"].dropna().unique()
        }

        if crop not in valid_crops:
            raise HTTPException(
                status_code=400,
                detail="The selected crop is not available.",
            )

        if season not in valid_seasons:
            raise HTTPException(
                status_code=400,
                detail="The selected season is not available.",
            )

        if district_a not in valid_districts or district_b not in valid_districts:
            raise HTTPException(
                status_code=400,
                detail="One or both selected districts are unavailable.",
            )

        crop_value = valid_crops[crop]
        season_value = valid_seasons[season]
        district_a_value = valid_districts[district_a]
        district_b_value = valid_districts[district_b]

        selected = df[
            (df["Crop"].str.casefold() == crop)
            & (df["Season"].str.casefold() == season)
            & (df["Crop_Year"] == year)
            & (df["District_Name"].str.upper().isin([district_a, district_b]))
        ].copy()

        # Include only fields useful for comparison and interpretation.
        result_columns = [
            "District_Name",
            "Crop_Year",
            "Season",
            "Crop",
            "Area",
            "Production",
            "Yield_kg_ha",
            "Yield_Status",
            "Weather_Rainfall_mm",
            "Weather_Mean_Temperature_C",
            "Weather_Min_Temperature_C",
            "Weather_Max_Temperature_C",
            "Weather_Relative_Humidity_pct",
            "Weather_Solar_Radiation_MJ_m2_day",
            "Weather_ET0_mm",
            "Weather_Data_Status",
            "Weather_Window_Start",
            "Weather_Window_End",
            "Weather_Source",
            "Soil_Soil_pH_H2O_0_5cm",
            "Soil_Organic_Carbon_g_per_kg_0_5cm",
            "Soil_Total_Nitrogen_g_per_kg_0_5cm",
            "Soil_Clay_pct_0_5cm",
            "Soil_Sand_pct_0_5cm",
            "Soil_Silt_pct_0_5cm",
            "Soil_CEC_cmol_per_kg_0_5cm",
            "Soil_Bulk_Density_kg_per_dm3_0_5cm",
            "Soil_Data_Status",
            "Soil_Source",
        ]

        result_columns = [col for col in result_columns if col in df.columns]

        def clean_record(row):
            result = {}
            for key, value in row.items():
                if pd.isna(value):
                    result[key] = None
                elif hasattr(value, "item"):
                    result[key] = value.item()
                else:
                    result[key] = value
            return result

        records_by_district = {}
        matching_rows = {}
        selected_year_status = {}

        for district in [district_a_value, district_b_value]:
            matches = selected[selected["District_Name"] == district]
            matching_rows[district] = int(len(matches))

            row, status = resolve_single_record(matches)
            selected_year_status[district] = status
            records_by_district[district] = (
                None if row is None else clean_record(row[result_columns].to_dict())
            )

        # Historical trend for each selected district and the same crop/season.
        trend_source = df[
            (df["Crop"].str.casefold() == crop)
            & (df["Season"].str.casefold() == season)
            & (df["District_Name"].str.upper().isin([district_a, district_b]))
        ].dropna(subset=["Crop_Year", "Yield_kg_ha"])

        trends = {}
        duplicate_years = {}
        conflicting_years = {}

        # Extra yearly fields attached to each trend point. They are optional
        # additions: "year" and "observed_yield" keep their original meaning.
        trend_extra_columns = {
            "area": "Area",
            "production": "Production",
            "rainfall_mm": "Weather_Rainfall_mm",
            "mean_temperature_c": "Weather_Mean_Temperature_C",
            "relative_humidity_pct": "Weather_Relative_Humidity_pct",
        }

        def optional_float(value):
            return None if pd.isna(value) else float(value)

        for district in [district_a_value, district_b_value]:
            district_rows = trend_source[
                trend_source["District_Name"] == district
            ].sort_values("Crop_Year")

            # More than one row for the same year is reported, never hidden.
            years = district_rows["Crop_Year"].astype(int)
            duplicate_years[district] = sorted(set(years[years.duplicated()].tolist()))

            points = []
            conflicting_years[district] = []
            for trend_year, year_rows in district_rows.groupby("Crop_Year"):
                row, status = resolve_single_record(year_rows)
                if row is None:
                    conflicting_years[district].append(int(trend_year))
                    continue
                points.append(
                    {
                        "year": int(row["Crop_Year"]),
                        "observed_yield": float(row["Yield_kg_ha"]),
                        **{
                            key: optional_float(row[column])
                            for key, column in trend_extra_columns.items()
                            if column in district_rows.columns
                        },
                    }
                )
            trends[district] = points

        record_a = records_by_district[district_a_value]
        record_b = records_by_district[district_b_value]

        yield_a = record_a.get("Yield_kg_ha") if record_a is not None else None
        yield_b = record_b.get("Yield_kg_ha") if record_b is not None else None

        difference = (
            float(yield_a) - float(yield_b)
            if yield_a is not None and yield_b is not None
            else None
        )

        percent_difference = None
        if difference is not None and float(yield_b) != 0:
            percent_difference = difference / abs(float(yield_b)) * 100

        # Fields whose value is exactly the same in both district records.
        identical_fields = []
        if record_a is not None and record_b is not None:
            for col in result_columns:
                value_a, value_b = record_a.get(col), record_b.get(col)
                if (
                    col not in ("District_Name", "Crop_Year", "Season", "Crop")
                    and isinstance(value_a, (int, float))
                    and isinstance(value_b, (int, float))
                    and value_a == value_b
                ):
                    identical_fields.append(col)

        # Several districts can carry ONE shared yield figure in the same year
        # (for example five chilli districts all at about 2,063 kg/ha in 2000).
        # Check it here so the dashboard can warn instead of reporting noise.
        by_year = {
            district: {
                point["year"]: point["observed_yield"] for point in trends[district]
            }
            for district in (district_a_value, district_b_value)
        }
        shared = sorted(set(by_year[district_a_value]) & set(by_year[district_b_value]))
        close_years = 0
        for shared_year in shared:
            first_value = by_year[district_a_value][shared_year]
            second_value = by_year[district_b_value][shared_year]
            middle = (first_value + second_value) / 2
            if first_value == second_value or (
                middle > 0 and abs(first_value - second_value) / middle < 0.01
            ):
                close_years += 1

        year_rows = df[
            (df["Crop"].str.casefold() == crop)
            & (df["Season"].str.casefold() == season)
            & (df["Crop_Year"] == year)
        ].dropna(subset=["Yield_kg_ha"])
        same_figure = []
        if yield_a is not None and float(yield_a) > 0:
            level = float(yield_a)
            same_figure = sorted(
                year_rows.loc[
                    (year_rows["Yield_kg_ha"] - level).abs() / level < 0.005,
                    "District_Name",
                ]
                .astype(str)
                .tolist()
            )
        similar_yields = {
            "shared_years": len(shared),
            "years_within_1_percent": close_years,
            "districts_with_record_selected_year": int(
                year_rows["District_Name"].nunique()
            ),
            "selected_year_group": same_figure,
            "selected_year_group_size": len(same_figure),
            "both_in_group": district_a_value in same_figure
            and district_b_value in same_figure,
            "flag": len(shared) >= 6 and close_years / len(shared) >= 0.6,
        }

        # Several districts sometimes carry the very same yield in a year even
        # though their areas differ hugely. Report it instead of hiding it.
        crop_season_rows = df[
            (df["Crop"].str.casefold() == crop)
            & (df["Season"].str.casefold() == season)
        ]
        shared = shared_figure_clusters(crop_season_rows)
        picked = [district_a_value, district_b_value]
        shared_figure_years = {
            name: sorted(y for (n, y) in shared if n == name) for name in picked
        }
        selected_year_shared = {
            name: (
                {
                    "districts_sharing": shared[(name, year)][0],
                    "yield": round(float(shared[(name, year)][1]), 1),
                }
                if (name, year) in shared
                else None
            )
            for name in picked
        }

        return {
            "data_source": DASHBOARD_CSV.name,
            "comparison": {
                "crop": crop_value,
                "season": season_value,
                "year": year,
                "district_a": district_a_value,
                "district_b": district_b_value,
                "yield_type": "Observed historical yield",
                "yield_unit_status": (
                    "kg/ha. In the source rows, yield equals production "
                    "(tonnes) x 1000 / area (hectares)."
                ),
                "units": DASHBOARD_UNITS,
                "district_a_minus_district_b": difference,
                "difference_percent_relative_to_district_b": (percent_difference),
            },
            "records": records_by_district,
            "historical_trends": trends,
            "data_quality": {
                "matching_rows_for_selected_year": matching_rows,
                "selected_year_status": selected_year_status,
                "years_with_multiple_rows": duplicate_years,
                "trend_years_excluded_conflicting_rows": conflicting_years,
                "identical_values_in_both_records": identical_fields,
                "shared_figure_years": shared_figure_years,
                "selected_year_shared": selected_year_shared,
                "similar_yields": similar_yields,
            },
            "interpretation_note": (
                "Weather and soil values describe available dataset "
                "indicators. Differences may be associated with yield "
                "differences but do not establish causation. SoilGrids "
                "values are model-derived estimates, not field measurements."
            ),
        }

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail="Could not generate the district comparison.",
        ) from exc


@app.get("/dashboard/overview")
def dashboard_overview(crop: str, season: str, year: int):
    """All-district summary for one crop, season and year.

    Returns headline numbers, a ranking of every district, the state-wide yield
    trend and each district's yield stability. Missing yields are left out and
    never counted as zero.
    """

    if not DASHBOARD_CSV.exists():
        raise HTTPException(
            status_code=503,
            detail="Dashboard historical data is unavailable.",
        )

    if year < 1997 or year > 2014:
        raise HTTPException(
            status_code=400,
            detail="Historical overview supports years 1997-2014.",
        )

    try:
        df = pd.read_csv(DASHBOARD_CSV)

        required = [
            "District_Name",
            "Crop_Year",
            "Season",
            "Crop",
            "Area",
            "Production",
            "Yield_kg_ha",
        ]
        if any(col not in df.columns for col in required):
            raise HTTPException(
                status_code=500,
                detail="Dashboard dataset is missing required columns.",
            )

        for col in ["District_Name", "Crop", "Season"]:
            df[col] = df[col].astype("string").str.strip()
        for col in ["Crop_Year", "Area", "Production", "Yield_kg_ha"]:
            df[col] = pd.to_numeric(df[col], errors="coerce")

        crops = {v.casefold(): v for v in df["Crop"].dropna().unique()}
        seasons = {v.casefold(): v for v in df["Season"].dropna().unique()}

        if crop.strip().casefold() not in crops:
            raise HTTPException(
                status_code=400, detail="The selected crop is not available."
            )
        if season.strip().casefold() not in seasons:
            raise HTTPException(
                status_code=400, detail="The selected season is not available."
            )

        result = build_overview(
            df,
            crops[crop.strip().casefold()],
            seasons[season.strip().casefold()],
            year,
        )
        result["data_source"] = DASHBOARD_CSV.name
        return result

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail="Could not generate the state overview.",
        ) from exc


# -------------------- Saved comparisons --------------------

SAVED_LIMIT = 10  # the smallest useful list; each entry is just a selection


class SaveComparisonRequest(BaseModel):
    district_a: str = Field(min_length=1, max_length=100)
    district_b: str = Field(min_length=1, max_length=100)
    crop: str = Field(min_length=1, max_length=100)
    season: str = Field(min_length=1, max_length=100)
    year: int = Field(ge=1997, le=2014)


def saved_out(doc):
    saved = doc.get("savedAt")
    if saved is not None and saved.tzinfo is None:
        saved = saved.replace(tzinfo=timezone.utc)
    return {
        "id": str(doc["_id"]),
        "district_a": doc["district_a"],
        "district_b": doc["district_b"],
        "crop": doc["crop"],
        "season": doc["season"],
        "year": doc["year"],
        "savedAt": saved.isoformat() if saved else None,
    }


@app.get("/saved-comparisons")
def list_saved_comparisons(who=Depends(current_user)):
    client = None
    try:
        client, db = get_database()
        client.admin.command("ping")
        docs = list(
            db["saved_comparisons"].find({"userId": str(who["id"])}).sort("savedAt", -1)
        )
        return {"limit": SAVED_LIMIT, "items": [saved_out(d) for d in docs]}
    except HTTPException:
        raise
    except Exception as exc:
        print(f"Saved comparisons could not be loaded: {type(exc).__name__}: {exc}")
        raise HTTPException(
            status_code=503,
            detail="We could not load your saved comparisons right now. Please try again.",
        ) from exc
    finally:
        if client is not None:
            client.close()


@app.post("/saved-comparisons", status_code=201)
def save_comparison(request: SaveComparisonRequest, who=Depends(current_user)):
    # Check the selection against the dataset and store the tidy names it returns.
    checked = dashboard_compare(
        district_a=request.district_a,
        district_b=request.district_b,
        crop=request.crop,
        season=request.season,
        year=request.year,
    )["comparison"]
    key = {
        "userId": str(who["id"]),
        "district_a": checked["district_a"],
        "district_b": checked["district_b"],
        "crop": checked["crop"],
        "season": checked["season"],
        "year": checked["year"],
    }

    client = None
    try:
        client, db = get_database()
        client.admin.command("ping")
        collection = db["saved_comparisons"]

        existing = collection.find_one(key)
        if existing is not None:
            return {"item": saved_out(existing), "already_saved": True}

        if collection.count_documents({"userId": key["userId"]}) >= SAVED_LIMIT:
            raise HTTPException(
                status_code=409,
                detail=f"You can keep up to {SAVED_LIMIT} saved comparisons. Remove one to save another.",
            )

        document = {**key, "savedAt": datetime.now(timezone.utc)}
        document["_id"] = collection.insert_one(document).inserted_id
        return {"item": saved_out(document), "already_saved": False}
    except HTTPException:
        raise
    except Exception as exc:
        print(f"Comparison could not be saved: {type(exc).__name__}: {exc}")
        raise HTTPException(
            status_code=503,
            detail="We could not save this comparison right now. Please try again.",
        ) from exc
    finally:
        if client is not None:
            client.close()


@app.delete("/saved-comparisons/{item_id}")
def delete_saved_comparison(item_id: str, who=Depends(current_user)):
    try:
        object_id = ObjectId(item_id)
    except InvalidId:
        raise HTTPException(status_code=404, detail="That comparison was not found.")

    client = None
    try:
        client, db = get_database()
        client.admin.command("ping")
        result = db["saved_comparisons"].delete_one(
            {"_id": object_id, "userId": str(who["id"])}
        )
        if result.deleted_count == 0:
            raise HTTPException(
                status_code=404, detail="That comparison was not found."
            )
        return {"deleted": True}
    except HTTPException:
        raise
    except Exception as exc:
        print(f"Comparison could not be removed: {type(exc).__name__}: {exc}")
        raise HTTPException(
            status_code=503,
            detail="We could not remove this comparison right now. Please try again.",
        ) from exc
    finally:
        if client is not None:
            client.close()


# -------------------- Weather and soil --------------------

WEATHER_BAND = (
    0.10  # a year is "wet" or "dry" when rainfall is 10% above or below usual
)

SOIL_INDICATORS = [
    ("Soil_Soil_pH_H2O_0_5cm", "Soil pH", ""),
    ("Soil_Organic_Carbon_g_per_kg_0_5cm", "Organic carbon", "g/kg"),
    ("Soil_Total_Nitrogen_g_per_kg_0_5cm", "Total nitrogen", "g/kg"),
    ("Soil_Clay_pct_0_5cm", "Clay", "%"),
    ("Soil_Sand_pct_0_5cm", "Sand", "%"),
    ("Soil_Silt_pct_0_5cm", "Silt", "%"),
    ("Soil_CEC_cmol_per_kg_0_5cm", "Cation exchange capacity", "cmol/kg"),
    ("Soil_Bulk_Density_kg_per_dm3_0_5cm", "Bulk density", "kg/dm\u00b3"),
]


def _load_dataset_frame():
    if not DASHBOARD_CSV.exists():
        raise HTTPException(
            status_code=503, detail="The data is not available right now."
        )
    df = pd.read_csv(DASHBOARD_CSV)
    strip_text_columns(df)
    df["Crop_Year"] = pd.to_numeric(df["Crop_Year"], errors="coerce")
    for column in (
        ["Yield_kg_ha", "Area", "Production"]
        + [c for c, _, _ in SOIL_INDICATORS]
        + [
            "Weather_Rainfall_mm",
            "Weather_Mean_Temperature_C",
            "Weather_Relative_Humidity_pct",
        ]
    ):
        if column in df.columns:
            df[column] = pd.to_numeric(df[column], errors="coerce")
    return df


def _plain_number(value, digits=1):
    if value is None or pd.isna(value):
        return None
    return round(float(value), digits)


@app.get("/weather/overview")
def weather_overview(crop: str, season: str, district: str):
    """Rainfall, temperature and humidity by year for one district, crop and season.

    A year is "wet" or "dry" when its rainfall is at least 10% above or below
    the district's own average over the recorded years.
    """
    try:
        df = _load_dataset_frame()
        crop_key, season_key, district_key = (
            crop.strip().casefold(),
            season.strip().casefold(),
            district.strip().upper(),
        )
        rows = df[
            (df["Crop"].str.casefold() == crop_key)
            & (df["Season"].str.casefold() == season_key)
            & (df["District_Name"].str.upper() == district_key)
        ]
        if rows.empty:
            raise HTTPException(
                status_code=404,
                detail="There is no weather record for this district, crop and season.",
            )

        columns = {
            "rainfall": "Weather_Rainfall_mm",
            "mean_temperature": "Weather_Mean_Temperature_C",
            "humidity": "Weather_Relative_Humidity_pct",
        }
        yearly = rows.groupby("Crop_Year")[list(columns.values())].mean().sort_index()
        usual = {key: _plain_number(yearly[col].mean()) for key, col in columns.items()}

        years = []
        for year, row in yearly.iterrows():
            rain = _plain_number(row[columns["rainfall"]])
            status = None
            if rain is not None and usual["rainfall"]:
                if rain >= usual["rainfall"] * (1 + WEATHER_BAND):
                    status = "wet"
                elif rain <= usual["rainfall"] * (1 - WEATHER_BAND):
                    status = "dry"
                else:
                    status = "normal"
            years.append(
                {
                    "year": int(year),
                    "rainfall": rain,
                    "mean_temperature": _plain_number(row[columns["mean_temperature"]]),
                    "humidity": _plain_number(row[columns["humidity"]], 0),
                    "status": status,
                }
            )

        return {
            "selection": {
                "crop": rows["Crop"].iloc[0],
                "season": rows["Season"].iloc[0],
                "district": rows["District_Name"].iloc[0],
            },
            "usual": usual,
            "years": years,
            "wet_years": [y["year"] for y in years if y["status"] == "wet"],
            "dry_years": [y["year"] for y in years if y["status"] == "dry"],
            "band_percent": int(WEATHER_BAND * 100),
            "data_source": DASHBOARD_CSV.name,
            "note": (
                "Weather is for the crop's growing window at one point per district "
                "(NASA POWER). It describes conditions and does not prove what caused a yield change."
            ),
        }
    except HTTPException:
        raise
    except Exception as exc:
        print(f"Weather overview failed: {type(exc).__name__}: {exc}")
        raise HTTPException(
            status_code=500,
            detail="We could not load the weather right now. Please try again.",
        )


@app.get("/soil/overview")
def soil_overview(district: str):
    """Soil values for one district, and where it sits among all districts.

    Soil values are model estimates that are the same in every year, so one value
    per district is shown. Ranks say only whether a value is higher or lower than
    other districts; they do not say whether higher is better.
    """
    try:
        df = _load_dataset_frame()
        columns = [column for column, _, _ in SOIL_INDICATORS if column in df.columns]
        per_district = df.groupby("District_Name")[columns].median()
        name_key = district.strip().upper()
        match = [name for name in per_district.index if str(name).upper() == name_key]
        if not match:
            raise HTTPException(
                status_code=404, detail="We have no soil record for this district."
            )
        selected = match[0]

        indicators = []
        for column, label, unit in SOIL_INDICATORS:
            if column not in per_district.columns:
                continue
            values = per_district[column].dropna()
            mine = values.get(selected)
            if mine is None or pd.isna(mine):
                indicators.append({"label": label, "unit": unit, "value": None})
                continue
            higher = int((values > mine).sum())
            indicators.append(
                {
                    "key": column,
                    "label": label,
                    "unit": unit,
                    "value": _plain_number(mine, 2),
                    "state_median": _plain_number(values.median(), 2),
                    "lowest": _plain_number(values.min(), 2),
                    "highest": _plain_number(values.max(), 2),
                    "higher_than_districts": higher,
                    "other_districts": int(len(values) - 1),
                }
            )

        return {
            "district": selected,
            "districts_total": int(len(per_district)),
            "indicators": indicators,
            "data_source": DASHBOARD_CSV.name,
            "note": (
                "SoilGrids model estimates for the top 5 cm of soil. They are the same in "
                "every year and are not field tests. Ask a soil testing laboratory for measured values."
            ),
        }
    except HTTPException:
        raise
    except Exception as exc:
        print(f"Soil overview failed: {type(exc).__name__}: {exc}")
        raise HTTPException(
            status_code=500,
            detail="We could not load the soil information right now. Please try again.",
        )


# -------------------- Field conditions (weather, yield and soil together) --------------------

SOIL_FIELD_COLUMNS = {
    "ph": ("Soil pH", "Soil_Soil_pH_H2O_0_5cm", ""),
    "organic_carbon": ("Organic carbon", "Soil_Organic_Carbon_g_per_kg_0_5cm", "g/kg"),
    "clay": ("Clay", "Soil_Clay_pct_0_5cm", "%"),
}


def soil_reading(key, value):
    """Plain reading and one practical meaning for a soil value (general soil science)."""
    if key == "ph":
        if value < 6.0:
            return (
                "Acidic",
                "Some nutrients, such as phosphorus, become less available. A soil test shows whether lime is worth adding.",
            )
        if value <= 7.5:
            return "Near neutral", "Most crops grow well in this range."
        return (
            "Alkaline",
            "Some micronutrients, such as zinc, can become less available. A soil test helps choose the right fertiliser.",
        )
    if key == "organic_carbon":
        if value < 5:
            return (
                "Low",
                "Organic matter is low. Farmyard manure or compost added over time helps.",
            )
        if value <= 7.5:
            return "Medium", "Keep adding organic matter to hold this level."
        return "High", "Good for holding water and nutrients."
    if value < 20:
        return "Sandy", "Water drains quickly, so irrigate little and often."
    if value <= 35:
        return "Balanced", "Holds water and nutrients well."
    return (
        "Heavy clay",
        "Holds water well but drains slowly. Avoid working it when wet.",
    )


@app.get("/field/overview")
def field_overview(district: str, crop: str, season: str, year: int | None = None):
    """One district's weather, yield and soil for one crop and season.

    Years are sorted into wet, dry or normal by comparing each season's rainfall
    with the district's own average (10% either way). Soil values are the
    district's median, which is the same in every year.
    """
    if not DASHBOARD_CSV.exists():
        raise HTTPException(
            status_code=503, detail="The data is not available right now."
        )
    try:
        df = pd.read_csv(DASHBOARD_CSV)
        strip_text_columns(df)
        numeric = [
            "Crop_Year",
            "Yield_kg_ha",
            "Weather_Rainfall_mm",
            "Weather_Mean_Temperature_C",
            "Weather_Relative_Humidity_pct",
        ] + [column for _, column, _ in SOIL_FIELD_COLUMNS.values()]
        for column in numeric:
            df[column] = pd.to_numeric(df[column], errors="coerce")

        rows = df[
            (df["Crop"].str.casefold() == crop.strip().casefold())
            & (df["Season"].str.casefold() == season.strip().casefold())
            & (df["District_Name"].str.upper() == district.strip().upper())
        ]
        if rows.empty:
            raise HTTPException(
                status_code=404,
                detail="There is no record for this district, crop and season.",
            )

        yearly = (
            rows.groupby("Crop_Year")[
                [
                    "Weather_Rainfall_mm",
                    "Weather_Mean_Temperature_C",
                    "Weather_Relative_Humidity_pct",
                    "Yield_kg_ha",
                ]
            ]
            .mean()
            .sort_index()
        )
        usual_rain = float(yearly["Weather_Rainfall_mm"].mean())

        def kind(rain):
            if pd.isna(rain):
                return "normal"
            if rain > usual_rain * (1 + WEATHER_BAND):
                return "wet"
            if rain < usual_rain * (1 - WEATHER_BAND):
                return "dry"
            return "normal"

        def clean(value, digits=1):
            return None if pd.isna(value) else round(float(value), digits)

        years = []
        for year_value, row in yearly.iterrows():
            years.append(
                {
                    "year": int(year_value),
                    "rainfall_mm": clean(row["Weather_Rainfall_mm"]),
                    "mean_temperature_c": clean(row["Weather_Mean_Temperature_C"]),
                    "humidity_pct": clean(row["Weather_Relative_Humidity_pct"], 0),
                    "yield_kg_ha": clean(row["Yield_kg_ha"], 0),
                    "kind": kind(row["Weather_Rainfall_mm"]),
                }
            )

        by_kind = {}
        for label in ("dry", "normal", "wet"):
            values = [
                item["yield_kg_ha"]
                for item in years
                if item["kind"] == label and item["yield_kg_ha"] is not None
            ]
            by_kind[label] = {
                "years": len(values),
                "average_yield_kg_ha": (
                    round(sum(values) / len(values), 0) if values else None
                ),
            }

        district_name = str(rows["District_Name"].iloc[0])
        medians = df.groupby("District_Name")[
            [column for _, column, _ in SOIL_FIELD_COLUMNS.values()]
        ].median()
        soil = []
        for key, (label, column, unit) in SOIL_FIELD_COLUMNS.items():
            value = medians.loc[district_name, column]
            state = medians[column].median()
            if pd.isna(value):
                continue
            reading, meaning = soil_reading(key, float(value))
            soil.append(
                {
                    "key": key,
                    "label": label,
                    "unit": unit,
                    "value": round(float(value), 2),
                    "statewide_median": round(float(state), 2),
                    "reading": reading,
                    "meaning": meaning,
                }
            )

        # Where this district's average yield sits among all districts for this crop and season.
        crop_season = df[
            (df["Crop"].str.casefold() == crop.strip().casefold())
            & (df["Season"].str.casefold() == season.strip().casefold())
        ]
        district_means = (
            crop_season.groupby("District_Name")["Yield_kg_ha"]
            .mean()
            .dropna()
            .sort_values(ascending=False)
        )
        ranked = list(district_means.index)
        my_mean = district_means.get(district_name)

        selected = (
            next((item for item in years if item["year"] == year), None)
            if year
            else None
        )
        return {
            "district": district_name,
            "crop": str(rows["Crop"].iloc[0]),
            "season": str(rows["Season"].iloc[0]),
            "usual_rainfall_mm": round(usual_rain, 1),
            "band_percent": int(WEATHER_BAND * 100),
            "years": years,
            "by_year_type": by_kind,
            "district_average_yield_kg_ha": clean(my_mean, 0),
            "state_average_yield_kg_ha": (
                clean(district_means.mean(), 0) if len(district_means) else None
            ),
            "rank": (
                ranked.index(district_name) + 1 if district_name in ranked else None
            ),
            "top_district": (
                displayed_top
                if (displayed_top := (ranked[0] if ranked else None))
                else None
            ),
            "top_district_yield_kg_ha": (
                clean(district_means.iloc[0], 0) if len(district_means) else None
            ),
            "district_count": len(ranked),
            "selected_year": selected,
            "soil": soil,
            "notes": [
                "Rainfall and temperature are for the crop's growing window, at one point per district (NASA POWER).",
                "Soil values are model estimates for the top 5 cm. They are the same in every year.",
                "Years with more or less rain are linked to yields in the past records, but that does not prove the rain caused the difference.",
            ],
        }
    except HTTPException:
        raise
    except Exception as exc:
        print(f"Field conditions could not be built: {type(exc).__name__}: {exc}")
        raise HTTPException(
            status_code=500, detail="We could not load field conditions right now."
        )


# -------------------- Satellite greenness (rice NDVI, 2018 to 2022) --------------------

NDVI_CSV = (
    DEPLOYMENT_DIR.parent
    / "02_Integrated_Data"
    / "Rice_NDVI_AP13_2018_2022_Standardized.csv"
)


@app.get("/satellite/overview")
def satellite_overview(district: str | None = None):
    """Rice greenness (NDVI, 0 to 1) by season for 2018, 2020 and 2022.

    NDVI measures how green the crop canopy is from satellite images. It is
    not a yield measure, and these seasons have no yield records here.
    """
    if not NDVI_CSV.exists():
        raise HTTPException(
            status_code=503, detail="The satellite data is not available right now."
        )
    try:
        df = pd.read_csv(NDVI_CSV)
        df["District_Name"] = df["District_Name"].astype(str).str.strip().str.upper()
        df["Season"] = df["Season"].astype(str).str.strip()
        df["rice_ndvi_mean"] = pd.to_numeric(df["rice_ndvi_mean"], errors="coerce")
        df["Crop_Year"] = pd.to_numeric(df["Crop_Year"], errors="coerce").astype(
            "Int64"
        )
        df = df.dropna(subset=["rice_ndvi_mean", "Crop_Year"])

        order = sorted(
            {
                (int(y), 0 if s.casefold() == "kharif" else 1, s)
                for y, s in zip(df["Crop_Year"], df["Season"])
            }
        )
        seasons, rankings = [], {}
        district_key = district.strip().upper() if district else None
        district_rows = []

        for year, _, season in order:
            label = f"{season} {year}"
            rows = df[(df["Crop_Year"] == year) & (df["Season"] == season)]
            values = rows.set_index("District_Name")["rice_ndvi_mean"].sort_values(
                ascending=False
            )
            rankings[label] = [
                {"district": name, "ndvi": round(float(v), 3)}
                for name, v in values.items()
            ]
            seasons.append(
                {
                    "label": label,
                    "year": year,
                    "season": season,
                    "mean": round(float(values.mean()), 3),
                    "min": round(float(values.min()), 3),
                    "max": round(float(values.max()), 3),
                    "districts": int(len(values)),
                }
            )
            if district_key and district_key in values.index:
                rank = list(values.index).index(district_key) + 1
                district_rows.append(
                    {
                        "label": label,
                        "ndvi": round(float(values[district_key]), 3),
                        "rank": rank,
                        "of": int(len(values)),
                        "season_mean": round(float(values.mean()), 3),
                    }
                )

        # 1. Consistency: average rank across all six seasons, and how far the rank moves.
        labels = [item["label"] for item in seasons]
        rank_table = {}
        for label in labels:
            for position, row in enumerate(rankings[label], start=1):
                rank_table.setdefault(row["district"], {})[label] = position
        consistency = []
        for name, ranks in rank_table.items():
            values = list(ranks.values())
            consistency.append(
                {
                    "district": name,
                    "average_rank": round(sum(values) / len(values), 1),
                    "best_rank": min(values),
                    "worst_rank": max(values),
                    "seasons": len(values),
                }
            )
        consistency.sort(key=lambda r: r["average_rank"])

        # 2. Kharif against Rabi in the same year: how much greener (or less) each district is in Rabi.
        season_change = []
        for name in rank_table:
            diffs = []
            for year in sorted({item["year"] for item in seasons}):
                k = df[
                    (df["Crop_Year"] == year)
                    & (df["Season"].str.casefold() == "kharif")
                    & (df["District_Name"] == name)
                ]["rice_ndvi_mean"]
                r_ = df[
                    (df["Crop_Year"] == year)
                    & (df["Season"].str.casefold() == "rabi")
                    & (df["District_Name"] == name)
                ]["rice_ndvi_mean"]
                if len(k) and len(r_):
                    diffs.append(float(r_.iloc[0]) - float(k.iloc[0]))
            if diffs:
                season_change.append(
                    {
                        "district": name,
                        "rabi_minus_kharif": round(sum(diffs) / len(diffs), 3),
                    }
                )
        season_change.sort(key=lambda r: r["rabi_minus_kharif"])

        # 3. Recent greenness against the district's historical rice yield (1997 to 2014).
        #    Different years, same districts: an exploratory check, not a yield forecast.
        history_check = None
        try:
            hist = pd.read_csv(DASHBOARD_CSV)
            hist = hist[hist["Crop"].astype(str).str.strip().str.casefold() == "rice"]
            hist = hist[
                hist["Season"].astype(str).str.strip().str.casefold() == "kharif"
            ]
            hist["District_Name"] = (
                hist["District_Name"].astype(str).str.strip().str.upper()
            )
            historical = (
                pd.to_numeric(hist["Yield_kg_ha"], errors="coerce")
                .groupby(hist["District_Name"])
                .mean()
            )
            recent = (
                df[df["Season"].str.casefold() == "kharif"]
                .groupby("District_Name")["rice_ndvi_mean"]
                .mean()
            )
            both = pd.DataFrame({"yield": historical, "greenness": recent}).dropna()
            if len(both) >= 5:
                correlation = both["yield"].rank().corr(both["greenness"].rank())
                history_check = {
                    "districts": int(len(both)),
                    "rank_correlation": round(float(correlation), 2),
                    "rows": [
                        {
                            "district": name,
                            "historical_yield_kg_ha": round(float(row["yield"]), 0),
                            "kharif_greenness": round(float(row["greenness"]), 3),
                        }
                        for name, row in both.sort_values(
                            "yield", ascending=False
                        ).iterrows()
                    ],
                    "meaning": "Districts with higher historical Kharif rice yields are not the greener ones in recent seasons. These are different years, only 13 districts, and greenness measures all vegetation in a district, not yield. Treat this as a pattern to investigate, not a prediction.",
                }
        except Exception as history_problem:
            print(f"History check unavailable: {history_problem}")

        return {
            "seasons": seasons,
            "rankings": rankings,
            "consistency": consistency,
            "season_change": season_change,
            "history_check": history_check,
            "district": (
                None
                if not district_key
                else {"name": district_key, "history": district_rows}
            ),
            "yield_check": {
                "correlation": 0.03,
                "spearman": 0.18,
                "observations": 26,
                "meaning": "In an earlier check of 26 district-seasons, greenness and rice yield were essentially unrelated. The sample is small, so this is only a first look.",
            },
            "scale_note": "NDVI runs from 0 to 1. Higher values mean a greener crop canopy.",
            "source": "Rice NDVI from satellite images, 2018, 2020 and 2022. Districts with a yield record for these years are not linked here.",
        }
    except HTTPException:
        raise
    except Exception as exc:
        print(f"Satellite overview could not be built: {type(exc).__name__}: {exc}")
        raise HTTPException(
            status_code=500, detail="We could not load the satellite data right now."
        )


# -------------------- AI provider (Groq) --------------------
#
# Every AI feature uses Groq's OpenAI-compatible Chat Completions API with the
# key from the backend .env file. The key never reaches the browser.

GROQ_BASE_URL = "https://api.groq.com/openai/v1"
DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile"


def groq_model_name():
    return os.getenv("GROQ_MODEL", DEFAULT_GROQ_MODEL)


def require_groq_key(feature_name):
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        print(
            f"{feature_name} is off: GROQ_API_KEY is missing from the backend .env file"
        )
        raise HTTPException(
            status_code=503,
            detail="The AI assistant is not set up yet.",
        )
    return api_key


def _retry_after_seconds(exc):
    """Seconds Groq asks us to wait, from the header or the error text."""
    try:
        header = exc.response.headers.get("retry-after")
        if header:
            return max(1, int(float(header) + 0.999))
    except Exception:
        pass
    found = re.search(
        r"try again in (?:(\d+)m)?\s*(\d+(?:\.\d+)?)s",
        str(getattr(exc, "message", "") or exc),
        re.I,
    )
    if found:
        minutes = int(found.group(1) or 0)
        return max(1, int(minutes * 60 + float(found.group(2)) + 0.999))
    return None


def groq_error_to_http(exc):
    """Turn a failed AI call into a short, plain message for the reader.

    The technical detail goes to the backend log only. Nothing about keys,
    providers or settings is shown on screen.
    """
    status = getattr(exc, "status_code", None)
    raw = str(getattr(exc, "message", "") or exc)
    print(f"AI call failed: {type(exc).__name__} status={status} detail={raw[:400]}")

    if isinstance(exc, RateLimitError) or status == 429:
        if re.search(r"per day|\bTPD\b|\bRPD\b", raw, re.I):
            return HTTPException(
                status_code=429,
                detail="The AI assistant has reached its limit for today. Please try again later.",
            )
        wait = _retry_after_seconds(exc)
        when = f"about {wait} seconds" if wait else "a minute"
        return HTTPException(
            status_code=429,
            detail=f"The AI assistant is busy right now. Please wait {when} and try again.",
        )
    if status == 413 or re.search(r"request too large", raw, re.I):
        return HTTPException(
            status_code=429,
            detail="That was too much for the AI assistant right now. Please wait a minute and try again.",
        )
    if isinstance(exc, (AuthenticationError, PermissionDeniedError)) or status in (
        401,
        403,
    ):
        print(
            "  -> the API key was rejected: check GROQ_API_KEY in the backend .env file"
        )
        return HTTPException(
            status_code=503,
            detail="The AI assistant is not available right now. Please try again later.",
        )
    if status in (400, 404) and re.search(
        r"decommission|model_not_found|does not exist|not found", raw, re.I
    ):
        print(
            f"  -> the model '{groq_model_name()}' is not available: set GROQ_MODEL in the backend .env file"
        )
        return HTTPException(
            status_code=503,
            detail="The AI assistant is not available right now. Please try again later.",
        )
    if isinstance(exc, APITimeoutError):
        return HTTPException(
            status_code=502,
            detail="The AI assistant took too long to answer. Please try again.",
        )
    if isinstance(exc, APIConnectionError):
        return HTTPException(
            status_code=502,
            detail="The AI assistant could not be reached. Please try again in a moment.",
        )
    if status is not None and status >= 500:
        return HTTPException(
            status_code=502,
            detail="The AI assistant is temporarily unavailable. Please try again shortly.",
        )
    return HTTPException(
        status_code=502,
        detail="The AI assistant could not answer that. Please try again.",
    )


def _error_body(exc):
    """The error object Groq returned, as a dict (empty when there is none)."""
    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        return body.get("error", body) if isinstance(body.get("error"), dict) else body
    return {}


def ask_groq(
    api_key, messages, *, max_tokens, temperature=0.2, timeout=45.0, json_mode=False
):
    """Send one chat request to Groq and return the reply text.

    json_mode asks Groq to return valid JSON. If Groq rejects the model's JSON
    it still returns what the model wrote ("failed_generation"); that text is
    passed on so the tolerant reader can repair it instead of the request
    failing. Other failures are raised as HTTPException with a message that
    names the cause.
    """
    client = OpenAI(
        api_key=api_key,
        base_url=GROQ_BASE_URL,
        timeout=timeout,
        max_retries=1,
    )
    request = {
        "model": groq_model_name(),
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if json_mode:
        request["response_format"] = {"type": "json_object"}
    if groq_model_name().startswith("openai/gpt-oss"):
        # These models think before they answer. Ask for light thinking and
        # leave room for the answer, otherwise the visible reply comes back empty.
        request["reasoning_effort"] = "low"
        request["max_tokens"] = max(max_tokens, 3000)

    try:
        try:
            response = client.chat.completions.create(**request)
        except Exception as exc:
            if not json_mode:
                raise
            details = _error_body(exc)
            written = details.get("failed_generation")
            if isinstance(written, str) and written.strip():
                print("Groq rejected the JSON; using the text the model wrote instead.")
                return written.strip()
            # JSON mode refused (no usable text, or the model has no JSON mode):
            # ask once more as plain text. The tolerant reader then checks the reply.
            if getattr(exc, "status_code", None) == 400 and (
                details.get("code") == "json_validate_failed"
                or re.search(
                    r"response_format|json_object|json mode|json_validate",
                    str(exc),
                    re.I,
                )
            ):
                print("Groq JSON mode refused; asking once more as plain text.")
                request.pop("response_format", None)
                response = client.chat.completions.create(**request)
            else:
                raise
    except Exception as exc:
        raise groq_error_to_http(exc) from exc
    choice = response.choices[0]
    text = (choice.message.content or "").strip()
    if not text:
        # Say why the reply is empty, so the cause shows in the backend log.
        usage = getattr(response, "usage", None)
        print(
            f"AI reply is empty: model={getattr(response, 'model', '?')} "
            f"finish_reason={getattr(choice, 'finish_reason', '?')} "
            f"max_tokens={max_tokens} usage={usage}"
        )
    return text


STATEWIDE_COLUMNS = [
    ("Weather_Rainfall_mm", "Rainfall"),
    ("Weather_Mean_Temperature_C", "Mean temperature"),
    ("Soil_Organic_Carbon_g_per_kg_0_5cm", "Soil organic carbon"),
    ("Soil_Clay_pct_0_5cm", "Soil clay"),
    ("Soil_Soil_pH_H2O_0_5cm", "Soil pH"),
]


def load_ai_context(district_a, district_b, crop, season, year):
    """Re-read the selected comparison from the dataset for the AI prompt.

    Returns (comparison_data, context). The state overview is optional: if it
    cannot be built, the AI features still run without it.
    """
    comparison_data = dashboard_compare(
        district_a=district_a,
        district_b=district_b,
        crop=crop,
        season=season,
        year=year,
    )

    try:
        selected = comparison_data["comparison"]
        overview = dashboard_overview(
            crop=selected["crop"],
            season=selected["season"],
            year=selected["year"],
        )
    except Exception as overview_problem:
        print(f"Dashboard overview unavailable for AI context: {overview_problem}")
        overview = None

    # Do rainfall, temperature and soil line up with yield across ALL districts?
    try:
        selected = comparison_data["comparison"]
        frame = pd.read_csv(DASHBOARD_CSV)
        strip_text_columns(frame)
        for column in ["Yield_kg_ha"] + [c for c, _ in STATEWIDE_COLUMNS]:
            if column in frame.columns:
                frame[column] = pd.to_numeric(frame[column], errors="coerce")
        statewide = statewide_associations(frame, selected["crop"], selected["season"])
    except Exception as statewide_problem:
        print(f"State-wide check unavailable for AI context: {statewide_problem}")
        statewide = None

    return comparison_data, build_insight_context(
        comparison_data, overview=overview, statewide=statewide
    )


NOTHING_TO_ANALYSE = (
    "No records exist for these districts with the selected crop and season, "
    "so there is nothing to analyse."
)


@app.post("/dashboard/insights")
def dashboard_insights(request: DashboardInsightRequest, http_request: Request):
    """Generate structured AI insights grounded in the selected records.

    The browser sends only the selection (districts, crop, season, year,
    language). The records, trends and differences are re-read from the
    dataset here, so the prompt cannot be altered from the browser.
    """

    language = request.language.strip().casefold()
    if language not in {"english", "telugu"}:
        raise HTTPException(
            status_code=400,
            detail="Language must be English or Telugu.",
        )
    enforce_rate_limit(http_request, "heavy")

    api_key = require_groq_key("AI explanation")

    try:
        # 1. Select the real records and pre-compute differences, trend
        #    statistics, state position and data gaps.
        comparison_data, context = load_ai_context(
            request.district_a,
            request.district_b,
            request.crop,
            request.season,
            request.year,
        )

        if not has_analysable_data(context):
            raise HTTPException(status_code=404, detail=NOTHING_TO_ANALYSE)

        language_name = "Telugu" if language == "telugu" else "English"
        messages = build_messages(context, language_name)

        def ask_model(model_messages):
            return ask_groq(
                api_key,
                model_messages,
                max_tokens=1400 if language == "telugu" else 1000,
                temperature=0.2,
                timeout=60.0,
                json_mode=True,
            )

        # 2. Ask the model, validate its JSON, and retry once if it is invalid.
        raw_text = ask_model(messages)
        try:
            result = parse_and_validate(raw_text, context)
        except InsightValidationError as first_problem:
            print(f"Dashboard AI output rejected (attempt 1): {first_problem}")
            print(f"  start of the reply: {raw_text[:300]!r}")
            raw_text = ask_model(
                build_repair_messages(messages, raw_text, str(first_problem))
            )
            try:
                result = parse_and_validate(raw_text, context)
            except InsightValidationError as second_problem:
                print(f"Dashboard AI output rejected (attempt 2): {second_problem}")
                print(f"  start of the reply: {raw_text[:300]!r}")
                raise HTTPException(
                    status_code=502,
                    detail="The AI assistant's answer could not be read. Please try again.",
                ) from second_problem

        return {
            "language": language_name,
            "model": groq_model_name(),
            "data_source": comparison_data["data_source"],
            "comparison": comparison_data["comparison"],
            "insights": result["insights"],
            "recommendations": result["recommendations"],
            # Markdown copy of the same content, kept for older clients.
            "explanation": render_markdown(result),
        }

    except HTTPException:
        raise
    except Exception as exc:
        # Keep credentials and internal error details out of API responses.
        print(f"Dashboard AI insights failed: {type(exc).__name__}: {exc}")
        raise HTTPException(
            status_code=502,
            detail=("The AI assistant could not write the insights. Please try again."),
        ) from exc


# -------------------- Conversational Dashboard Chatbot --------------------

from typing import Literal


class DashboardChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    # Long assistant answers are accepted and trimmed before use, so a long
    # explanation in the history never makes the next question fail.
    content: str = Field(min_length=1, max_length=12000)


class DashboardChatRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    # Reply language chosen with the English / తెలుగు switch.
    language: Literal["english", "telugu"] = "english"
    # "chat": answer any agricultural question; dashboard data is used only
    #         when the question is about it.
    # "explain": explain the analyzed comparison (Explain Results button).
    mode: Literal["chat", "explain"] = "chat"
    history: list[DashboardChatMessage] = Field(default_factory=list, max_length=20)
    # The comparison currently shown on the dashboard. Send all five fields,
    # or none when nothing has been analyzed yet.
    district_a: str | None = Field(default=None, max_length=100)
    district_b: str | None = Field(default=None, max_length=100)
    crop: str | None = Field(default=None, max_length=100)
    season: str | None = Field(default=None, max_length=100)
    year: int | None = Field(default=None, ge=1997, le=2014)
    # A short description of what the person is looking at on another page,
    # for example a yield estimate. Used as background only.
    page_context: str | None = Field(default=None, max_length=1500)

    def selection(self):
        values = {
            "district_a": (self.district_a or "").strip(),
            "district_b": (self.district_b or "").strip(),
            "crop": (self.crop or "").strip(),
            "season": (self.season or "").strip(),
            "year": self.year,
        }
        if all(value not in (None, "") for value in values.values()):
            return values
        return None


@app.post("/dashboard/chat")
def dashboard_chat(request: DashboardChatRequest, http_request: Request):
    """
    Conversational assistant for the Dashboard.

    mode "chat" answers general agricultural questions and uses the analyzed
    comparison as context when one is sent. mode "explain" explains that
    comparison. Dashboard values are always re-read from the dataset.
    """

    api_key = require_groq_key("The chatbot")
    enforce_rate_limit(http_request, "heavy" if request.mode == "explain" else "chat")

    question = request.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Enter a question.")

    selection = request.selection()
    explain = request.mode == "explain"
    telugu = request.language.casefold() == "telugu"

    if explain and selection is None:
        raise HTTPException(
            status_code=400,
            detail="Analyze a district comparison first, then ask for an explanation.",
        )

    # Everyday questions are answered from the model's own knowledge. The
    # dashboard data is attached only when the question is about it, which
    # keeps replies quick and the Groq token use low.
    wants_dashboard = explain or (
        selection is not None and question_mentions_dashboard(question, selection)
    )

    comparison_data = None
    context = None
    context_note = None

    if selection is not None and wants_dashboard:
        try:
            comparison_data, context = load_ai_context(**selection)
        except HTTPException:
            if explain:
                raise
            context_note = (
                "The dashboard comparison could not be loaded, so no dashboard "
                "data is available for this answer."
            )
        except Exception as exc:
            print(f"Dashboard chat context failed: {type(exc).__name__}: {exc}")
            if explain:
                raise HTTPException(
                    status_code=500,
                    detail="Could not load the comparison to explain.",
                ) from exc
            context_note = (
                "The dashboard comparison could not be loaded, so no dashboard "
                "data is available for this answer."
            )
    elif selection is not None:
        context_note = (
            "The person has a comparison open on their dashboard, but their "
            "question is not about it, so no dashboard data is attached."
        )

    if explain:
        if not has_analysable_data(context):
            raise HTTPException(status_code=404, detail=NOTHING_TO_ANALYSE)
        messages = build_explain_messages(context, request.language)
        max_tokens, temperature = (900 if telugu else 600), 0.2
    else:
        messages = build_chat_messages(
            question,
            [item.model_dump() for item in request.history],
            compact_chat_context(context),
            context_note,
            request.page_context,
            language=request.language,
        )
        max_tokens, temperature = (900 if telugu else 600), 0.5

    try:
        answer = ask_groq(
            api_key,
            messages,
            max_tokens=max_tokens,
            temperature=temperature,
            timeout=45.0,
        )
    except HTTPException:
        raise
    except Exception as exc:
        print(f"Dashboard chatbot error: {type(exc).__name__}: {exc}")
        raise HTTPException(
            status_code=502,
            detail="The AI assistant could not respond. Please try again.",
        ) from exc

    if not answer:
        raise HTTPException(
            status_code=502,
            detail="The AI assistant returned an empty answer. Try again.",
        )

    response = {
        "answer": answer,
        "mode": request.mode,
        "model": groq_model_name(),
        "used_dashboard_data": context is not None,
        "data_source": (comparison_data or {}).get("data_source"),
        "selection": selection,
    }
    if explain:
        # "unverified" means at least one figure in the answer could not be
        # found in the data sent to the model.
        response["figures_check"] = check_figures(answer, context)
    return response
