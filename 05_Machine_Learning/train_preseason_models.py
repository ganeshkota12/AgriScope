from pathlib import Path
import json
import joblib
import numpy as np
import pandas as pd

from sklearn.compose import ColumnTransformer
from sklearn.ensemble import ExtraTreesRegressor
from sklearn.impute import SimpleImputer
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder

PROJECT = Path(r"C:\MINI_PROJECT_FINAL")
DATA_PATH = PROJECT / "02_Integrated_Data" / "Seasonal_Yield_Preseason_Weather.csv"
OUTPUT_DIR = PROJECT / "04_Deployment" / "preseason_models"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

TEST_START = 2011
TEST_END = 2014
TRAIN_END = 2010

df = pd.read_csv(DATA_PATH)
df.columns = df.columns.str.strip()

required = [
    "District_Name",
    "Crop",
    "Season",
    "Crop_Year",
    "Yield_kg_ha",
    "Yield_Lag_1Y",
    "Yield_Lag_2Y",
    "Yield_Rolling_Mean_3Y",
]
missing = [c for c in required if c not in df.columns]
if missing:
    raise ValueError(f"Required columns missing: {missing}")

for c in ["District_Name", "Crop", "Season"]:
    df[c] = df[c].astype(str).str.strip()

df["Crop_Year"] = pd.to_numeric(df["Crop_Year"], errors="coerce")
df["Yield_kg_ha"] = pd.to_numeric(df["Yield_kg_ha"], errors="coerce")
df = df.dropna(subset=["Crop_Year", "Yield_kg_ha"]).copy()
df["Crop_Year"] = df["Crop_Year"].astype(int)

keys = ["District_Name", "Crop", "Season", "Crop_Year"]
if df.duplicated(keys).any():
    raise ValueError("Duplicate district/crop/season/year records found.")

# Only features intended to be available before the crop-season cutoff.
history_features = [
    "Yield_Lag_1Y",
    "Yield_Lag_2Y",
    "Yield_Rolling_Mean_3Y",
]

soil_features = [
    c
    for c in df.columns
    if c.startswith("Soil_")
    and "contributing_pixels" not in c.lower()
    and pd.api.types.is_numeric_dtype(df[c])
    and df[c].notna().any()
]

preseason_features = [
    c
    for c in df.columns
    if c.startswith("Preseason_")
    and c != "Preseason_Mean_Evapotranspiration_Source_Units"
    and pd.api.types.is_numeric_dtype(df[c])
    and df[c].notna().any()
]

# Explicitly exclude full-season weather, target-derived current-year values,
# identifiers, and the unverified rainfall-temperature interaction.
numeric_features = list(
    dict.fromkeys(history_features + soil_features + preseason_features)
)
categorical_features = ["District_Name", "Season"]
feature_columns = numeric_features + categorical_features

for crop in ["Rice", "Dry chillies"]:
    crop_df = df[df["Crop"].str.casefold() == crop.casefold()].copy()

    train = crop_df[
        (crop_df["Crop_Year"] <= TRAIN_END) & crop_df["Yield_Lag_1Y"].notna()
    ].copy()

    test = crop_df[
        crop_df["Crop_Year"].between(TEST_START, TEST_END)
        & crop_df["Yield_Lag_1Y"].notna()
    ].copy()

    if len(train) < 30 or len(test) < 10:
        raise ValueError(
            f"Insufficient eligible rows for {crop}: "
            f"train={len(train)}, test={len(test)}"
        )

    # Fit the model using only years up to 2010.
    transformers = [
        (
            "numeric",
            Pipeline(
                [
                    ("imputer", SimpleImputer(strategy="median")),
                ]
            ),
            numeric_features,
        ),
        (
            "categorical",
            Pipeline(
                [
                    ("imputer", SimpleImputer(strategy="most_frequent")),
                    ("encoder", OneHotEncoder(handle_unknown="ignore")),
                ]
            ),
            categorical_features,
        ),
    ]

    model = Pipeline(
        [
            (
                "preprocessor",
                ColumnTransformer(
                    transformers=transformers,
                    remainder="drop",
                ),
            ),
            (
                "model",
                ExtraTreesRegressor(
                    n_estimators=300,
                    min_samples_leaf=3,
                    max_features=0.7,
                    random_state=42,
                    n_jobs=-1,
                ),
            ),
        ]
    )

    model.fit(train[feature_columns], train["Yield_kg_ha"])
    predictions = model.predict(test[feature_columns])

    mae = mean_absolute_error(test["Yield_kg_ha"], predictions)
    rmse = np.sqrt(mean_squared_error(test["Yield_kg_ha"], predictions))
    r2 = r2_score(test["Yield_kg_ha"], predictions)

    results = test[
        ["District_Name", "Crop", "Season", "Crop_Year", "Yield_kg_ha"]
    ].copy()
    results["Predicted_Yield_kg_ha"] = predictions
    results["Absolute_Error_kg_ha"] = np.abs(
        results["Yield_kg_ha"] - results["Predicted_Yield_kg_ha"]
    )
    results["Evaluation_Type"] = (
        "Chronological holdout; prior observed yields available"
    )
    results.to_csv(
        OUTPUT_DIR / f"{crop.replace(' ', '_')}_test_predictions.csv", index=False
    )

    stem = "Rice" if crop == "Rice" else "Dry_Chillies"
    joblib.dump(model, OUTPUT_DIR / f"{stem}_Preseason_Model.joblib")

    metadata = {
        "crop": crop,
        "model": "ExtraTreesRegressor",
        "feature_columns": feature_columns,
        "numeric_features": numeric_features,
        "categorical_features": categorical_features,
        "target": "Yield_kg_ha",
        "train_end_year": TRAIN_END,
        "test_years": [TEST_START, TEST_END],
        "training_rows": len(train),
        "test_rows": len(test),
        "mae_kg_ha": float(mae),
        "rmse_kg_ha": float(rmse),
        "r2": float(r2),
        "weather_timing_verified_preseason": False,
        "cutoffs_are_experimental_assumptions": True,
        "dataset": DATA_PATH.name,
        "excluded_full_season_weather": True,
        "note": (
            "Preseason-feature experiment. Validate crop calendar cutoffs, "
            "weather provenance, yield units, and lag availability before "
            "describing this model as deployment-ready."
        ),
    }

    with open(
        OUTPUT_DIR / f"{stem}_Preseason_Metadata.json", "w", encoding="utf-8"
    ) as f:
        json.dump(metadata, f, indent=2)

    print(f"\n=== {crop} ===")
    print(f"Training rows: {len(train)} (years <= {TRAIN_END})")
    print(f"Test rows: {len(test)} ({TEST_START}-{TEST_END})")
    print(f"MAE:  {mae:.3f} kg/ha")
    print(f"RMSE: {rmse:.3f} kg/ha")
    print(f"R²:   {r2:.4f}")
    print(f"Saved model in: {OUTPUT_DIR}")

print("\nPreseason model experiments completed.")
print("These results are separate from the earlier experimental models.")
