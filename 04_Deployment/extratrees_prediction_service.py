
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

PROJECT = Path(r"C:\MINI_PROJECT_FINAL")
DATA_PATH = (
    PROJECT / "02_Integrated_Data"
    / "Seasonal_Yield_Feature_Engineered_v2.csv"
)
MODEL_DIR = PROJECT / "04_Deployment"

CROP_FILES = {
    "rice": (
        "Rice_ExtraTrees_Model.joblib",
        "Rice_ExtraTrees_Metadata.joblib",
    ),
    "dry chillies": (
        "Dry_Chillies_ExtraTrees_Model.joblib",
        "Dry_Chillies_ExtraTrees_Metadata.joblib",
    ),
}


def load_history():
    df = pd.read_csv(DATA_PATH)
    df.columns = df.columns.str.strip()

    for col in ["District_Name", "Crop", "Season"]:
        df[col] = df[col].astype(str).str.strip()

    df["Crop_Year"] = pd.to_numeric(df["Crop_Year"], errors="coerce")
    df["Yield_kg_ha"] = pd.to_numeric(df["Yield_kg_ha"], errors="coerce")
    df = df.dropna(
        subset=["District_Name", "Crop", "Season", "Crop_Year", "Yield_kg_ha"]
    ).copy()
    df["Crop_Year"] = df["Crop_Year"].astype(int)

    keys = ["District_Name", "Crop", "Season", "Crop_Year"]
    if df.duplicated(keys).any():
        raise ValueError("Duplicate district/crop/season/year records found.")

    lookup = df.set_index(keys)["Yield_kg_ha"].to_dict()

    for lag in range(1, 6):
        df[f"Lag_{lag}Y"] = [
            lookup.get(
                (r.District_Name, r.Crop, r.Season, int(r.Crop_Year) - lag),
                np.nan,
            )
            for r in df.itertuples()
        ]

    lag3 = ["Lag_1Y", "Lag_2Y", "Lag_3Y"]
    df["Rolling2Y"] = df[["Lag_1Y", "Lag_2Y"]].mean(axis=1, skipna=False)
    df["Rolling3Y"] = df[lag3].mean(axis=1, skipna=False)
    df["Weighted3Y"] = (
        0.50 * df["Lag_1Y"]
        + 0.30 * df["Lag_2Y"]
        + 0.20 * df["Lag_3Y"]
    ).where(df[lag3].notna().all(axis=1))
    df["Trend3Y"] = (
        (df["Lag_1Y"] - df["Lag_3Y"]) / 2
    ).where(df[lag3].notna().all(axis=1))
    df["Variability3Y"] = df[lag3].std(axis=1, ddof=0).where(
        df[lag3].notna().all(axis=1)
    )

    return df


def predict_extratrees(district, crop, season, year):
    """Predict using a saved ExtraTrees model and its training feature schema."""

    crop_key = crop.strip().casefold()
    if crop_key not in CROP_FILES:
        raise ValueError("Crop must be Rice or Dry chillies.")

    district = district.strip()
    season = season.strip().title()
    year = int(year)

    # The app's prediction page is restricted to 2011–2014.
    if year not in range(2011, 2015):
        raise ValueError("Prediction year must be between 2011 and 2014.")

    model_file, metadata_file = CROP_FILES[crop_key]
    model = joblib.load(MODEL_DIR / model_file)
    metadata = joblib.load(MODEL_DIR / metadata_file)

    df = load_history()
    crop_name = metadata["crop"]

    history = df[
        (df["District_Name"].str.casefold() == district.casefold())
        & (df["Crop"].str.casefold() == crop_name.casefold())
        & (df["Season"].str.casefold() == season.casefold())
    ]

    sample = history[history["Crop_Year"] == year]
    if len(sample) != 1:
        raise ValueError(
            f"Expected one historical feature row for {district}, "
            f"{crop_name}, {season}, {year}; found {len(sample)}."
        )

    sample = sample.iloc[[0]]
    required_lags = ["Lag_1Y", "Lag_2Y", "Lag_3Y"]
    if sample[required_lags].isna().any(axis=None):
        raise ValueError(
            "Prediction unavailable: the previous three years of "
            "yield history are incomplete."
        )

    features = metadata["feature_columns"]
    missing = [c for c in features if c not in sample.columns]
    if missing:
        raise ValueError(f"Missing model input features: {missing}")

    # Current row weather features may be full-season values. This
    # guard prevents us from claiming verified preseason prediction.
    if not metadata.get("weather_timing_verified_preseason", False):
        if any(c.startswith("Weather_") for c in features) or (
            "Rainfall_Temperature_Interaction" in features
        ):
            raise ValueError(
                "This saved model has unverified weather feature timing. "
                "It cannot yet be used as a verified preseason prediction."
            )

    prediction = float(model.predict(sample[features])[0])
    if not np.isfinite(prediction):
        raise ValueError("Model returned a non-finite prediction.")

    return {
        "District_Name": sample.iloc[0]["District_Name"],
        "Crop": crop_name,
        "Season": season,
        "Target_Year": year,
        "Predicted_Yield_kg_ha": round(prediction, 2),
        "Model": metadata["model"],
        "Feature_Set": metadata["selected_feature_set"],
        "Prediction_Status": "Experimental model prediction",
    }
