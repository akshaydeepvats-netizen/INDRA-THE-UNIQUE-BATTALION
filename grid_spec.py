"""Common INDRA analysis grid (regular lat/lon). 0.025 deg ~= 2.5-2.8 km over India."""
LAT_N, LAT_S = 38.0, 5.0
LON_W, LON_E = 66.0, 99.0
RES = 0.025
NROWS = int(round((LAT_N - LAT_S) / RES))
NCOLS = int(round((LON_E - LON_W) / RES))
CELL_KM = RES * 111.32  # north-south size of one cell


def rc(lat, lon):
    return int((LAT_N - lat) / RES), int((lon - LON_W) / RES)


def latlon(r, c):
    return LAT_N - (r + 0.5) * RES, LON_W + (c + 0.5) * RES
