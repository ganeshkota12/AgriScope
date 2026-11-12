import pandas as pd
from pathlib import Path

ROOT = Path(r"C:\MINI_PROJECT_FINAL")

INPUT = ROOT / "03_Integrated_Data" / "FINAL_KAGGLE_INTEGRATED_MASTER.csv"

OUT = ROOT / "04_EDA" / "Kaggle_1997_2014"

df = pd.read_csv(INPUT)

# Normalize categorical columns
for col in ["Crop", "Season", "District_Name"]:
    df[col] = df[col].astype(str).str.strip()

# ------------------------------------------
# 1. WEATHER CORRELATIONS
# Exclude derived Whole Year weather rows
# ------------------------------------------

weather_columns = [
    "Rainfall_mm",
    "Mean_Temperature_C",
    "Min_Temperature_C",
    "Max_Temperature_C",
    "Relative_Humidity_pct",
    "Solar_Radiation_MJ_m2_day",
    "ET0_mm"
]

seasonal = df[
    df["Season"].isin(["Kharif", "Rabi"])
    & df["Crop"].isin(["Rice", "Dry chillies"])
].copy()

results = []

for crop, group in seasonal.groupby("Crop"):

    for feature in weather_columns:

        valid = group[
            [feature, "Yield_kg_ha"]
        ].dropna()

        results.append({
            "Crop": crop,
            "Weather_Feature": feature,
            "Observations": len(valid),
            "Correlation": (
                valid[feature].corr(valid["Yield_kg_ha"])
                if len(valid) >= 3 else None
            )
        })

correlations = pd.DataFrame(results)

correlations.to_csv(
    OUT / "Weather_Yield_Correlations_Seasonal_Only.csv",
    index=False
)

# ------------------------------------------
# 2. VERIFY YIELD FORMULA
# ------------------------------------------

df["Calculated_Yield"] = (
    df["Production"] * 1000 / df["Area"]
)

df["Yield_Difference"] = (
    df["Calculated_Yield"] - df["Yield_kg_ha"]
).abs()

formula_mismatches = int(
    (df["Yield_Difference"] > 0.02).sum()
)

# ------------------------------------------
# 3. WEATHER STATUS AUDIT
# ------------------------------------------

weather_status = df["Data_Status"].value_counts(
    dropna=False
)

# ------------------------------------------
# 4. SAVE AUDIT REPORT
# ------------------------------------------

report = f"""
AGRISCOPE - FINAL DATA QUALITY AUDIT
====================================

Dataset:
FINAL_KAGGLE_INTEGRATED_MASTER.csv

Total records: {len(df)}
Districts: {df['District_Name'].nunique()}
Crops: {df['Crop'].nunique()}
Year range: {int(df['Crop_Year'].min())}-{int(df['Crop_Year'].max())}

Yield formula:
Yield (kg/ha) = Production (tonnes) * 1000 / Area (hectares)

Records with formula difference greater than 0.02 kg/ha:
{formula_mismatches}

Maximum formula difference:
{df['Yield_Difference'].max():.6f} kg/ha

Weather status:
{weather_status.to_string()}

Weather correlations:
Calculated using Kharif and Rabi records only.
Whole Year records are excluded because their weather
values are derived from seasonal weather records.

Correlation results:
{correlations.to_string(index=False)}

Interpretation:
Correlations indicate association, not causation.
Soil variables are district-level modelled estimates.
Whole Year weather values are derived, not independent
seasonal observations.
"""

(OUT / "Final_Data_Quality_Audit.txt").write_text(
    report,
    encoding="utf-8"
)

print(report)

print("\nCORRECTION COMPLETED")
print("Files saved:")
print(OUT / "Weather_Yield_Correlations_Seasonal_Only.csv")
print(OUT / "Final_Data_Quality_Audit.txt")

