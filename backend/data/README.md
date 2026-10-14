# External dataset placement

The raw datasets are deliberately not included in this repository. They are
large, have independent licenses, and must not be bundled with the project.

## NASA Ames PCoE Li-ion Battery Aging Dataset

The NASA catalog entry currently documents the MATLAB `cycle` structure and
reports no downloadable resources. Obtain the original battery run `.mat`
files from the NASA Ames PCoE Li-ion Battery Aging Dataset entry linked by the
[NASA dataset page](https://data.nasa.gov/dataset/li-ion-battery-aging-datasets).
Place the downloaded battery-run files in this directory:

```text
backend/data/nasa/B0005.mat
backend/data/nasa/B0006.mat
backend/data/nasa/B0007.mat
backend/data/nasa/B0018.mat
```

The loader selects only `cycle.type == "discharge"`. It uses
`data.Time` (seconds), `Voltage_measured` (V), `Current_measured` (A),
`Temperature_measured` (degrees C), and the recorded discharge `Capacity`
(Ah) as the target. No conversion is applied to those units. Features are
computed only from the same discharge's time/sensor arrays; the target
capacity is excluded from model inputs. Runs are held out by battery ID.
Capacity-derived SOH is calculated as `Capacity / 2.0 Ah * 100`, using the
dataset's stated 2 Ah rated capacity.

If the current NASA catalog page does not offer the original `.mat` files,
training cannot proceed until they are obtained through NASA Ames PCoE's
official dataset download channel. Do not substitute third-party repackaged
data without verifying its provenance and schema.

## ETAS SynCAN Dataset

Download all four training archives and the six labelled test archives from
the [official ETAS SynCAN repository](https://github.com/etas/SynCAN), then
place them in `backend/data/synCAN/` with these exact names:

```text
train_1.zip
train_2.zip
train_3.zip
train_4.zip
test_normal.zip
test_plateau.zip
test_continuous.zip
test_playback.zip
test_suppress.zip
test_flooding.zip
```

The repository README describes each CSV row as `Label`, `ID`, `Time`, and
`SignalN_of_ID` columns. `Time` is milliseconds; labels are 0 (normal) and 1
(intrusion). Train archives are combined as normal-only data (training labels
are all zero). Testing uses the official row labels. Signal counts are
ID-specific as documented in the upstream README; signals from different IDs
are not treated as the same physical measurement. No conversions or mappings
to this project's DBC signal names/IDs are made.

SynCAN is licensed by ETAS/Bosch for non-commercial academic, teaching,
publication, or personal simulation use only, not field use. Include the
dataset citation in any work using it; do not redistribute the source data.
See the upstream [license terms](https://github.com/etas/SynCAN/blob/master/License%20terms.txt)
and [README/citation](https://github.com/etas/SynCAN/blob/master/README.md).
