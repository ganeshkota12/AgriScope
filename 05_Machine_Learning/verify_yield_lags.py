
import pandas as pd

path = r"C:\MINI_PROJECT_FINAL\02_Integrated_Data\Seasonal_Yield_Feature_Engineered_v2.csv"
df = pd.read_csv(path)

keys = ["District_Name", "Crop", "Season"]
df["Crop_Year"] = pd.to_numeric(df["Crop_Year"])
df = df.sort_values(keys + ["Crop_Year"]).reset_index(drop=True)

groups = df.groupby(keys, dropna=False)

df["expected_lag1"] = groups["Yield_kg_ha"].shift(1)
df["expected_lag2"] = groups["Yield_kg_ha"].shift(2)
df["expected_roll3"] = groups["Yield_kg_ha"].transform(
    lambda s: s.shift(1).rolling(3, min_periods=3).mean()
)

checks = [
    ("Yield_Lag_1Y", "expected_lag1"),
    ("Yield_Lag_2Y", "expected_lag2"),
    ("Yield_Rolling_Mean_3Y", "expected_roll3"),
]

print("Historical feature verification")

for stored, expected in checks:
    actual_values = pd.to_numeric(df[stored], errors="coerce")
    expected_values = df[expected]

    comparable = actual_values.notna() & expected_values.notna()
    mismatches = (
        (actual_values[comparable] - expected_values[comparable]).abs() > 0.01
    ).sum()

    print(f"\n{stored}")
    print(f"  Mismatches: {mismatches}")
    print(f"  Expected missing: {expected_values.isna().sum()}")
    print(f"  Stored missing: {actual_values.isna().sum()}")
