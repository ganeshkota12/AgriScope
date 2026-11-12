from __future__ import annotations

import pandas as pd


def build_overview(
    df: pd.DataFrame,
    crop: str,
    season: str,
    year: int,
) -> dict:
    """Build the all-district historical dashboard overview."""

    required = [
        "District_Name",
        "Crop_Year",
        "Season",
        "Crop",
        "Area",
        "Production",
        "Yield_kg_ha",
    ]
    missing_columns = [c for c in required if c not in df.columns]
    if missing_columns:
        raise ValueError(f"Dataset is missing required columns: {missing_columns}")

    data = df[required].copy()

    for col in ["District_Name", "Crop", "Season"]:
        data[col] = data[col].astype("string").str.strip()

    for col in ["Crop_Year", "Area", "Production", "Yield_kg_ha"]:
        data[col] = pd.to_numeric(data[col], errors="coerce")

    # Select the requested crop and season, ignoring letter case.
    selected = data[
        data["Crop"].str.casefold().eq(crop.casefold())
        & data["Season"].str.casefold().eq(season.casefold())
    ].copy()

    selected = selected.dropna(subset=["District_Name", "Crop_Year"])
    selected["Crop_Year"] = selected["Crop_Year"].astype(int)

    if selected.empty:
        raise ValueError("No historical records exist for this crop and season.")

    # Keep the first source row for each district-year combination.
    duplicate_count = int(selected.duplicated(["District_Name", "Crop_Year"]).sum())
    selected = selected.drop_duplicates(["District_Name", "Crop_Year"], keep="first")

    districts = sorted(selected["District_Name"].dropna().unique().tolist())
    selected_year = selected[selected["Crop_Year"] == year].copy()

    # Use only finite, non-missing yields. Missing yields are never zero-filled.
    selected_year = selected_year[
        selected_year["Yield_kg_ha"].notna()
        & (selected_year["Yield_kg_ha"].abs() != float("inf"))
    ]

    selected_year = selected_year.sort_values(
        ["Yield_kg_ha", "District_Name"],
        ascending=[False, True],
    )

    ranking = []
    for rank, (_, row) in enumerate(selected_year.iterrows(), start=1):
        ranking.append(
            {
                "district": str(row["District_Name"]),
                "rank": rank,
                "yield": float(row["Yield_kg_ha"]),
                "area": (float(row["Area"]) if pd.notna(row["Area"]) else None),
                "production": (
                    float(row["Production"]) if pd.notna(row["Production"]) else None
                ),
            }
        )

    districts_with_yield = set(selected_year["District_Name"].astype(str).tolist())
    districts_without_yield = [d for d in districts if d not in districts_with_yield]

    def finite_values(series):
        values = pd.to_numeric(series, errors="coerce").dropna()
        return values[values.map(lambda v: pd.notna(v) and abs(v) != float("inf"))]

    valid_yields = finite_values(selected_year["Yield_kg_ha"])
    valid_areas = finite_values(
        selected_year.loc[selected_year["Area"].notna(), "Area"]
    )
    valid_production = finite_values(
        selected_year.loc[selected_year["Production"].notna(), "Production"]
    )

    def total_or_none(values):
        return float(values.sum()) if len(values) else None

    highest = None
    lowest = None
    if not selected_year.empty:
        high = selected_year.iloc[0]
        low = selected_year.iloc[-1]
        highest = {
            "district": str(high["District_Name"]),
            "yield": float(high["Yield_kg_ha"]),
        }
        lowest = {
            "district": str(low["District_Name"]),
            "yield": float(low["Yield_kg_ha"]),
        }

    headline = {
        "districts_with_yield": int(len(valid_yields)),
        "districts_total": int(len(districts)),
        "mean_yield": (float(valid_yields.mean()) if len(valid_yields) else None),
        "highest": highest,
        "lowest": lowest,
        "gap_highest_lowest": (
            float(highest["yield"] - lowest["yield"])
            if highest is not None and lowest is not None
            else None
        ),
        "total_production": total_or_none(valid_production),
        "districts_with_production": int(selected_year["Production"].notna().sum()),
        "total_area": total_or_none(valid_areas),
        "districts_with_area": int(selected_year["Area"].notna().sum()),
    }

    # Calculate a simple mean of district yields for each year.
    state_trend = []
    for trend_year in range(1997, 2015):
        year_data = selected[selected["Crop_Year"] == trend_year].copy()
        year_data = year_data[
            year_data["Yield_kg_ha"].notna()
            & year_data["Yield_kg_ha"].map(lambda v: abs(v) != float("inf"))
        ]

        values = year_data["Yield_kg_ha"]
        state_trend.append(
            {
                "year": trend_year,
                "districts_with_yield": int(values.count()),
                "mean_yield": float(values.mean()) if len(values) else None,
                "max_yield": float(values.max()) if len(values) else None,
                "min_yield": float(values.min()) if len(values) else None,
            }
        )

    trend_with_data = [item for item in state_trend if item["mean_yield"] is not None]

    best_year = None
    worst_year = None
    if trend_with_data:
        best = max(trend_with_data, key=lambda item: item["mean_yield"])
        worst = min(trend_with_data, key=lambda item: item["mean_yield"])
        best_year = {
            "year": best["year"],
            "mean_yield": best["mean_yield"],
            "districts_with_yield": best["districts_with_yield"],
        }
        worst_year = {
            "year": worst["year"],
            "mean_yield": worst["mean_yield"],
            "districts_with_yield": worst["districts_with_yield"],
        }

    trend_highlights = {
        "best_year": best_year,
        "worst_year": worst_year,
        "rule": "Highest and lowest yearly means use recorded district yields only.",
    }

    # Calculate district-level historical yield stability.
    stability = []
    for district in districts:
        history = selected[
            selected["District_Name"].eq(district)
            & selected["Yield_kg_ha"].notna()
            & selected["Yield_kg_ha"].map(lambda v: abs(v) != float("inf"))
        ][["Crop_Year", "Yield_kg_ha"]].sort_values("Crop_Year")

        values = history["Yield_kg_ha"]
        count = int(values.count())
        mean_yield = float(values.mean()) if count else None
        cv_percent = None

        if count >= 3 and mean_yield not in (None, 0):
            cv_percent = float(values.std(ddof=0) / abs(mean_yield) * 100)

        lowest_record = None
        highest_record = None
        if count:
            low_index = values.idxmin()
            high_index = values.idxmax()
            low_row = history.loc[low_index]
            high_row = history.loc[high_index]
            lowest_record = {
                "year": int(low_row["Crop_Year"]),
                "yield": float(low_row["Yield_kg_ha"]),
            }
            highest_record = {
                "year": int(high_row["Crop_Year"]),
                "yield": float(high_row["Yield_kg_ha"]),
            }

        stability.append(
            {
                "district": str(district),
                "mean_yield": mean_yield,
                "cv_percent": cv_percent,
                "years_recorded": count,
                "lowest": lowest_record,
                "highest": highest_record,
            }
        )

    zero_yield_districts = sorted(
        selected_year.loc[selected_year["Yield_kg_ha"].eq(0), "District_Name"]
        .astype(str)
        .unique()
        .tolist()
    )

    return {
        "selection": {
            "crop": crop,
            "season": season,
            "year": int(year),
        },
        "headline": headline,
        "ranking": ranking,
        "districts_without_yield": districts_without_yield,
        "state_trend": state_trend,
        "trend_highlights": trend_highlights,
        "stability": stability,
        "data_quality": {
            "district_years_with_multiple_rows": duplicate_count,
            "districts_with_zero_yield_in_selected_year": zero_yield_districts,
        },
        "notes": [
            "District yields are reported values; missing yields are excluded, not treated as zero.",
            "For duplicate district-year records, only the first source row is used.",
            "Statewide yearly means are simple averages of available district yields.",
            "Yield stability is calculated from recorded annual yields; at least three observations are required for the variability chart.",
        ],
    }
