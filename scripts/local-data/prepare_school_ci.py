"""Create an invented school source with enough active neighbors for SEO checks."""

import argparse
import copy
from decimal import Decimal
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    source = json.loads(Path(__file__).with_name("example.school.synthetic.json").read_text(encoding="utf-8"))
    if source.get("synthetic") is not True:
        raise ValueError("synthetic fixture required")
    for school in source["tables"]["schools"]:
        # The partitioner needs a real prefecture label; all school facts stay
        # invented. These coordinates are fabricated, not copied from a school.
        school["prefecture"] = "東京都"
    for table in ("school_name_history", "school_relationships"):
        for row in source["tables"][table]:
            row["official_url"] = row["official_url"].replace("https://history.example/", "https://school.example/history/")
    first = source["tables"]["schools"][0]
    # Retain the retired school/history and all admission fixtures. Additional
    # invented schools exercise the normal >=3-neighbor link verification.
    for number in range(3, 6):
        school = copy.deepcopy(first)
        school["id"] = f"00000000-0000-4000-8000-{number:012d}"
        school["record_key"] = f"synthetic-ci-school-{number}"
        school["name"] = f"合成近隣学校{number}"
        school["latitude"] = str(Decimal("35.123") + Decimal(number) / 1000)
        school["longitude"] = str(Decimal("139.765") + Decimal(number) / 1000)
        source["tables"]["schools"].append(school)
    with args.output.open("x", encoding="utf-8") as file:
        json.dump(source, file, ensure_ascii=False)
        file.write("\n")
    print("Invented CI source prepared; no real data or network used.")


if __name__ == "__main__":
    main()
