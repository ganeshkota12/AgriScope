from pathlib import Path
import joblib
import pandas as pd
import numpy as np

BASE = Path(r"C:\MINI_PROJECT_FINAL")
DATA = BASE / "02_Integrated_Data" / "Seasonal_Yield_Feature_Engineered_v2.csv"
MODEL_DIR = BASE / "04_Deployment"

df = pd.read_csv(DATA)

for col in ["District_Name", "Crop", "Season"]:
    df[col] = df[col].astype(str).str.strip()

df["Crop_Year"] = pd.to_numeric(df["Crop_Year"], errors="coerce")
df["Yield_kg_ha"] = pd.to_numeric(df["Yield_kg_ha"], errors="coerce")
df = df.dropna(subset=["Crop_Year", "Yield_kg_ha"]).copy()
df["Crop_Year"] = df["Crop_Year"].astype(int)

for crop, filename in [
    ("Rice", "Rice_Ridge_Model.joblib"),
    ("Dry chillies", "Dry_Chillies_Ridge_Model.joblib"),
]:
    model_path = MODEL_DIR / filename
    metadata_path = MODEL_DIR / filename.replace("_Model.joblib", "_Metadata.joblib")

    model = joblib.load(model_path)
    metadata = joblib.load(metadata_path)

    crop_df = df[df["Crop"] == crop].copy()
    keys = ["District_Name", "Crop", "Season"]
    lookup = crop_df.set_index(keys + ["Crop_Year"])["Yield_kg_ha"]

    for n in [1, 2, 3]:
        crop_df[f"Lag_{n}Y"] = [
            lookup.get(
                (row.District_Name, row.Crop, row.Season, row.Crop_Year - n),
                np.nan,
            )
            for row in crop_df.itertuples()
        ]

    lag_cols = ["Lag_1Y", "Lag_2Y", "Lag_3Y"]
    crop_df["Roll_3Y"] = (
        crop_df[lag_cols].mean(axis=1).where(crop_df[lag_cols].notna().all(axis=1))
    )
    crop_df["YoY_Change"] = crop_df["Lag_1Y"] - crop_df["Lag_2Y"]

    for col in ["Lag_1Y", "Lag_2Y", "Lag_3Y", "Roll_3Y"]:
        crop_df[f"{col}_missing"] = crop_df[col].isna().astype(int)

    # Choose a real row with a known previous-year yield.
    samples = crop_df.dropna(subset=["Lag_1Y"]).sort_values("Crop_Year")
    if samples.empty:
        print(f"{crop}: no eligible sample found")
        continue

    sample = samples.tail(1)
    prediction = float(model.predict(sample[metadata["feature_columns"]])[0])

    print(f"\nCrop: {crop}")
    print(f"Sample district: {sample.iloc[0]['District_Name']}")
    print(f"Season: {sample.iloc[0]['Season']}")
    print(f"Year: {sample.iloc[0]['Crop_Year']}")
    print(f"Predicted yield: {prediction:.2f} kg/ha")
    print(f"Prediction is finite: {np.isfinite(prediction)}")
