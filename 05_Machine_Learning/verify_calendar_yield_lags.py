from pathlib import Path
import pandas as pd
import numpy as np

path = Path(
    r"C:\MINI_PROJECT_FINAL\02_Integrated_Data"
    r"\Seasonal_Yield_Feature_Engineered_v2.csv"
)

df = pd.read_csv(path)
keys = ["District_Name", "Crop", "Season"]
year = "Crop_Year"
target = "Yield_kg_ha"

df[year] = pd.to_numeric(df[year], errors="coerce")
df[target] = pd.to_numeric(df[target], errors="coerce")
df = df.dropna(subset=keys + [year]).copy()
df[year] = df[year].astype(int)
df = df.sort_values(keys + [year]).reset_index(drop=True)

duplicate_keys = df.duplicated(keys + [year]).sum()
year_gaps = 0
lag1_mismatches = 0
lag2_mismatches = 0
roll3_mismatches = 0
checked_lag1 = checked_lag2 = checked_roll3 = 0

for _, group in df.groupby(keys, dropna=False):
    lookup = dict(zip(group[year], group[target]))

    for _, row in group.iterrows():
        y = row[year]
        actual = row[target]

        expected1 = lookup.get(y - 1, np.nan)
        expected2 = lookup.get(y - 2, np.nan)
        past3 = [lookup.get(y - j, np.nan) for j in (1, 2, 3)]
        expected_roll = (
            np.mean(past3) if all(pd.notna(v) for v in past3) else np.nan
        )

        if y - 1 not in lookup:
            year_gaps += 1

        checks = [
            ("Yield_Lag_1Y", expected1, "lag1"),
            ("Yield_Lag_2Y", expected2, "lag2"),
            ("Yield_Rolling_Mean_3Y", expected_roll, "roll3"),
        ]

        for col, expected, label in checks:
            if col not in df.columns:
                continue

            stored = pd.to_numeric(pd.Series([row[col]]), errors="coerce").iloc[0]

            if pd.notna(expected) and pd.notna(stored):
                if label == "lag1":
                    checked_lag1 += 1
                elif label == "lag2":
                    checked_lag2 += 1
                else:
                    checked_roll3 += 1

                if abs(stored - expected) > 0.01:
                    if label == "lag1":
                        lag1_mismatches += 1
                    elif label == "lag2":
                        lag2_mismatches += 1
                    else:
                        roll3_mismatches += 1

print("CALENDAR-YEAR LAG AUDIT")
print("Rows:", len(df))
print("Duplicate district/crop/season/year keys:", duplicate_keys)
print("Rows without a prior calendar year:", year_gaps)
print("Lag-1 checked / mismatches:", checked_lag1, "/", lag1_mismatches)
print("Lag-2 checked / mismatches:", checked_lag2, "/", lag2_mismatches)
print("Rolling-3 checked / mismatches:", checked_roll3, "/", roll3_mismatches)
print("Note: this checks values where both stored and expected features exist.")