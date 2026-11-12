import json
from pathlib import Path

import joblib
import pandas as pd

ROOT = Path(r"C:\MINI_PROJECT_FINAL")
DATA_PATH = ROOT / "02_Integrated_Data" / "Seasonal_Yield_Preseason_Weather.csv"
MODEL_DIR = ROOT / "04_Deployment" / "preseason_models"

CROP_FILES = {
    "rice": (
        "Rice",
        "Rice_Preseason_Model.joblib",
        "Rice_Preseason_Metadata.json",
    ),
    "dry chillies": (
        "Dry chillies",
        "Dry_Chillies_Preseason_Model.joblib",
        "Dry_Chillies_Preseason_Metadata.json",
    ),
}

YEARS = (2011, 2012, 2013, 2014)

_df = None
_models = {}


def load_resources():
    global _df, _models

    if _df is None:
        _df = pd.read_csv(DATA_PATH)

        for col in ("Crop", "District_Name", "Season"):
            _df[col] = _df[col].astype(str).str.strip()

        _df["Crop_Year"] = pd.to_numeric(_df["Crop_Year"], errors="coerce")

        if _df.duplicated(["District_Name", "Crop", "Season", "Crop_Year"]).any():
            raise RuntimeError("Duplicate district/crop/season/year records exist.")

    for key, (crop_name, model_file, metadata_file) in CROP_FILES.items():
        if key not in _models:
            with (MODEL_DIR / metadata_file).open("r", encoding="utf-8") as f:
                metadata = json.load(f)

            feature_columns = metadata.get("feature_columns")
            if not feature_columns:
                raise RuntimeError(f"{metadata_file} has no feature_columns.")

            pipeline = joblib.load(MODEL_DIR / model_file)

            # Check that the saved model and metadata agree.
            model_features = getattr(pipeline, "feature_names_in_", None)
            if model_features is not None:
                if list(model_features) != list(feature_columns):
                    raise RuntimeError(f"Feature order mismatch in {model_file}.")

            _models[key] = {
                "crop": crop_name,
                "pipeline": pipeline,
                "metadata": metadata,
                "features": list(feature_columns),
            }

    return _df, _models


def _median(series):
    values = pd.to_numeric(series, errors="coerce").dropna()
    return float(values.median()) if not values.empty else float("nan")


def _find_history(df, district, crop, season):
    return df[
        df["District_Name"].str.lower().eq(district.lower())
        & df["Crop"].str.lower().eq(crop.lower())
        & df["Season"].str.lower().eq(season.lower())
    ].sort_values("Crop_Year")


def _historical_yield(history, year):
    """Yield for one exact earlier year; never substitutes another year."""
    rows = history[history["Crop_Year"].eq(year)]
    if len(rows) != 1 or "Yield_kg_ha" not in rows.columns:
        return float("nan")

    value = pd.to_numeric(rows.iloc[0]["Yield_kg_ha"], errors="coerce")
    return float(value) if pd.notna(value) else float("nan")


def _build_fallback_row(df, crop, district, season, year, features):
    """
    Create a temporary feature row for a missing historical combination.

    Does not add the row to the source CSV and never invents the current
    year's target yield. Weather features use peer medians; soil features
    use district historical medians where available. Missing lag values
    remain NaN for the saved pipeline's fitted imputer.
    """
    row = {column: float("nan") for column in features}
    row["District_Name"] = district
    row["Season"] = season

    crop_mask = df["Crop"].str.lower().eq(crop.lower())
    season_mask = df["Season"].str.lower().eq(season.lower())
    year_mask = df["Crop_Year"].eq(year)
    district_mask = df["District_Name"].str.lower().eq(district.lower())

    peers = df[crop_mask & season_mask & year_mask]
    crop_season = df[crop_mask & season_mask]
    crop_history = df[crop_mask]
    district_crop_history = df[crop_mask & district_mask]
    district_history = df[district_mask]

    history = _find_history(df, district, crop, season)

    for column in features:
        if column in ("District_Name", "Season"):
            continue

        if column == "Yield_Lag_1Y":
            row[column] = _historical_yield(history, year - 1)
            continue

        if column == "Yield_Lag_2Y":
            row[column] = _historical_yield(history, year - 2)
            continue

        if column == "Yield_Rolling_Mean_3Y":
            previous = [
                _historical_yield(history, year - offset) for offset in (1, 2, 3)
            ]
            valid = [value for value in previous if pd.notna(value)]
            row[column] = sum(valid) / len(valid) if valid else float("nan")
            continue

        if column.startswith("Soil_"):
            # Soil attributes are district-based, not season-specific.
            value = _median(
                district_history[column]
                if column in district_history
                else pd.Series(dtype=float)
            )
            if pd.isna(value):
                value = _median(
                    crop_history[column]
                    if column in crop_history
                    else pd.Series(dtype=float)
                )
            row[column] = value
            continue

        # Prefer same crop + season + year peers for weather/features.
        if column in peers.columns:
            value = _median(peers[column])
            if pd.isna(value):
                value = _median(crop_season[column])
            if pd.isna(value):
                value = _median(crop_history[column])
            row[column] = value

    return pd.DataFrame([row], columns=features)


def get_prediction(district, crop, season, year):
    """Calculate a retrospective ML estimate for 2011–2014."""
    df, models = load_resources()

    try:
        year = int(year)
    except (TypeError, ValueError):
        raise ValueError("Year must be between 2011 and 2014.")

    if year not in YEARS:
        raise ValueError("Predictions are restricted to test years 2011–2014.")

    crop_key = str(crop).strip().lower()
    if crop_key not in CROP_FILES:
        raise ValueError("Crop must be Rice or Dry chillies.")

    district = str(district).strip()
    season = str(season).strip()

    if not district or not season:
        raise ValueError("District and season are required.")

    selected = models[crop_key]
    crop_name = selected["crop"]
    metadata = selected["metadata"]
    features = selected["features"]

    valid_districts = set(df["District_Name"].str.lower())
    valid_seasons = set(df["Season"].str.lower())

    if district.lower() not in valid_districts:
        raise ValueError(f"Unknown district: {district}")

    if season.lower() not in valid_seasons:
        raise ValueError(f"Unknown season: {season}")

    matches = df[
        df["Crop"].str.lower().eq(crop_name.lower())
        & df["District_Name"].str.lower().eq(district.lower())
        & df["Season"].str.lower().eq(season.lower())
        & df["Crop_Year"].eq(year)
    ]

    if len(matches) > 1:
        raise ValueError("Multiple matching records found; prediction is ambiguous.")

    if len(matches) == 1:
        source_row = matches.iloc[0]
        X = pd.DataFrame(
            [{column: source_row[column] for column in features}],
            columns=features,
        )
        input_status = "Historical feature record"
        imputed_features = [column for column in features if pd.isna(X.iloc[0][column])]
    else:
        X = _build_fallback_row(df, crop_name, district, season, year, features)
        input_status = "Temporary row using documented peer/district fallbacks"
        imputed_features = list(features)

    if "Yield_kg_ha" in features:
        raise RuntimeError(
            "Unsafe model metadata: target yield appears in model features."
        )

    # Missing lag values are intentionally passed to the fitted pipeline's
    # SimpleImputer. Do not manually reject them before prediction.
    try:
        prediction = float(selected["pipeline"].predict(X)[0])
    except Exception as exc:
        raise RuntimeError(
            f"Model prediction failed for {district}, {crop_name}, "
            f"{season}, {year}: {exc}"
        ) from exc

    if pd.isna(prediction):
        raise RuntimeError("The model returned an invalid prediction.")

    metrics = {
        key: metadata[key]
        for key in ("mae_kg_ha", "rmse_kg_ha", "r2")
        if key in metadata
    }

    return {
        "district": district,
        "crop": crop_name,
        "season": season,
        "year": year,
        "predicted_yield_kg_ha": round(max(0.0, prediction), 2),
        "model_type": "Saved preseason ML pipeline",
        "evaluation_period": "2011–2014 retrospective test years",
        "input_status": input_status,
        "missing_input_features": imputed_features,
        "metrics": metrics,
        "caveat": (
            "Experimental retrospective estimate. Weather cutoff assumptions "
            "and weather provenance have not been independently verified. "
            "When a historical feature row is absent, temporary features are "
            "estimated from historical peer/district data. This may reduce "
            "prediction reliability."
        ),
    }


def get_prediction_options():
    """
    Return all valid district/crop/season/year choices for the UI.
    Includes the full requested grid so missing historical rows can still
    be selected and handled by the fallback prediction path.
    """
    df, _ = load_resources()
    districts = sorted(df["District_Name"].dropna().unique())
    crops = ["Rice", "Dry chillies"]
    seasons = ["Kharif", "Rabi"]

    return pd.DataFrame(
        [
            {
                "District_Name": district,
                "Crop": crop,
                "Season": season,
                "Crop_Year": year,
            }
            for district in districts
            for crop in crops
            for season in seasons
            for year in YEARS
        ]
    )
