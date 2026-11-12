
from pathlib import Path
import joblib
import numpy as np
import pandas as pd
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

BASE = Path(r"C:\MINI_PROJECT_FINAL")
DATA = BASE / "02_Integrated_Data" / "Seasonal_Yield_Feature_Engineered_v2.csv"
MODEL_DIR = BASE / "04_Deployment"

df = pd.read_csv(DATA)
df.columns = df.columns.str.strip()

for col in ["District_Name", "Crop", "Season"]:
    df[col] = df[col].astype(str).str.strip()

df["Crop_Year"] = pd.to_numeric(df["Crop_Year"], errors="coerce")
df["Yield_kg_ha"] = pd.to_numeric(df["Yield_kg_ha"], errors="coerce")
df = df.dropna(subset=["Crop_Year", "Yield_kg_ha"]).copy()
df["Crop_Year"] = df["Crop_Year"].astype(int)

keys = ["District_Name", "Crop", "Season", "Crop_Year"]
if df.duplicated(keys).any():
    raise ValueError("Duplicate crop/year keys found.")

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
    0.50 * df["Lag_1Y"] + 0.30 * df["Lag_2Y"] + 0.20 * df["Lag_3Y"]
).where(df[lag3].notna().all(axis=1))
df["Trend3Y"] = (
    (df["Lag_1Y"] - df["Lag_3Y"]) / 2
).where(df[lag3].notna().all(axis=1))
df["Variability3Y"] = df[lag3].std(axis=1, ddof=0).where(
    df[lag3].notna().all(axis=1)
)

for crop, stem in [
    ("Rice", "Rice_ExtraTrees"),
    ("Dry chillies", "Dry_Chillies_ExtraTrees"),
]:
    model_path = MODEL_DIR / f"{stem}_Model.joblib"
    meta_path = MODEL_DIR / f"{stem}_Metadata.joblib"

    model = joblib.load(model_path)
    meta = joblib.load(meta_path)
    features = meta["feature_columns"]

    crop_df = df[
        (df["Crop"].str.lower() == crop.lower())
        & df["Crop_Year"].between(2011, 2014)
        & df[lag3].notna().all(axis=1)
    ].copy()

    if crop_df.empty:
        print(f"\n{crop}: no eligible test rows")
        continue

    # Check feature availability and prepare the held-out test rows.
    missing = [c for c in features if c not in crop_df.columns]
    if missing:
        print(f"\n{crop}: missing model features: {missing}")
        continue

    X = crop_df[features]
    y = crop_df["Yield_kg_ha"].astype(float)
    pred = model.predict(X)

    print(f"\n--- {crop} ExtraTrees ---")
    print(f"Feature set: {meta['selected_feature_set']}")
    print(f"Test rows: {len(y)}")
    print(f"MAE: {mean_absolute_error(y, pred):.3f} kg/ha")
    print(f"RMSE: {np.sqrt(mean_squared_error(y, pred)):.3f} kg/ha")
    print(f"R2: {r2_score(y, pred):.6f}")
    print(f"Predictions finite: {np.isfinite(pred).all()}")
    print(f"Saved metadata training rows: {meta['training_rows']}")
    print(f"Training cutoff: {meta['train_end_year']}")
