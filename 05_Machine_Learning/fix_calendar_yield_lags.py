from pathlib import Path
import pandas as pd
import numpy as np

root = Path(r"C:\MINI_PROJECT_FINAL\02_Integrated_Data")
source = root / "Seasonal_Yield_Feature_Engineered_v2.csv"
output = root / "Seasonal_Yield_Feature_Engineered_v3_lagfix.csv"

df = pd.read_csv(source)
keys = ["District_Name", "Crop", "Season"]
year = "Crop_Year"
target = "Yield_kg_ha"

df[year] = pd.to_numeric(df[year], errors="coerce")
df[target] = pd.to_numeric(df[target], errors="coerce")
df = df.sort_values(keys + [year]).reset_index(drop=True)

# Use exact calendar years, never merely the previous available row.
for col in ["Yield_Lag_1Y", "Yield_Lag_2Y", "Yield_Rolling_Mean_3Y"]:
    if col not in df.columns:
        df[col] = np.nan

for _, idx in df.groupby(keys, dropna=False, sort=False).groups.items():
    part = df.loc[idx]
    lookup = dict(zip(part[year].astype(int), part[target]))

    for i in idx:
        y = int(df.at[i, year])
        df.at[i, "Yield_Lag_1Y"] = lookup.get(y - 1, np.nan)
        df.at[i, "Yield_Lag_2Y"] = lookup.get(y - 2, np.nan)

        past = [lookup.get(y - j, np.nan) for j in (1, 2, 3)]
        df.at[i, "Yield_Rolling_Mean_3Y"] = (
            float(np.mean(past)) if all(pd.notna(v) for v in past) else np.nan
        )

df.to_csv(output, index=False)

print("Saved corrected copy:", output.name)
print("Rows:", len(df))
for col in ["Yield_Lag_1Y", "Yield_Lag_2Y", "Yield_Rolling_Mean_3Y"]:
    print(col, "| missing:", int(df[col].isna().sum()))

print("Original dataset was not modified.")