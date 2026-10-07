# Cross-Team Analysis Toolbox

## Team Members
Ajay Parthibha, Amelia Zheng, Rhea Agrawal

## Summary
The Cross-Team Analysis Toolbox is an interactive visualization platform designed to support the Mechanical, Electrical, and Autonomy subteams in analyzing vehicle performance data. 

It provides two core functionalities: 
- Dynamic Analysis: Visualizes recorded ROS bag data
- Static Analysis: Parses and visualizes CSV and ROS bag data, creating dynamic plots
  
The project is fully dockerized for easy deployment and can be hosted locally within the ELL environment.

## Design Flow 
User uploads ROSBag or CSV files via the web interface.
Files are parsed and stored in PostgreSQL, and available for users to select from a dropdown menu.
Workflows are divided into:
- Dynamic Analysis → ROSBag replay and 3D visualizations
- Static Analysis → CSV data plots and statistics

## How to Use 
1. Clone the repository
2. Run ```docker compose up --build```

## Application Architecture
![Application Architecture](./architecture.png)

### Frontend
- React.js: Displays visualizations, manages user interactions, and communicates with backend APIs.
- Shiny for Python: Provides the static visualization interface for CSV and parsed ROSBag data

### Backend
Python (PyWorker):
- Parses CSV and ROSBag data.
- Handles database uploads and data formatting
  
Node.js + Express.js:
- Manages routing and server endpoints.
- Interfaces with PostgreSQL for data retrieval
  
PostgreSQL:
- Stores parsed CSV and ROSBag data 
### Usage



## Running CAT with EVIL (recordings come from EVIL, CAT is a cache)

[EVIL](https://github.com/cornellev/evil) is where recordings are uploaded and kept (raw, exactly as
uploaded, plus a catalog saying what each one is). With EVIL connected, CAT does not hold its own
copies:

- **Lists come from EVIL.** The Dynamic and Static tabs list the rosbags and CSVs in EVIL's catalog,
  with their human names. (The ids CAT's API uses are EVIL's recording ids; the human name is in `label`.)
- **The first open builds a cache.** Selecting a recording asks EVIL to prepare it; EVIL's worker has CAT's
  pyworker decode it into Postgres and the page shows "Preparing…" with progress. Later opens are instant.
- **Caches are evicted.** After a week without being opened (or when the total passes a size cap, least
  recently used first) a recording's rows are deleted from CAT's database. Opening it again rebuilds it from
  the original file, which EVIL still has. Nothing is lost by eviction.
- **Any bag is readable.** A message type that is not installed in the pyworker image is stored undecoded
  (raw bytes), the rest of the bag still works, and the topic shows "(not decoded)". To decode it, build the
  package into `msg_packages/` with `scripts/build_msg_package.sh /path/to/pkg`; no image rebuild is needed.
- **Uploading moved to EVIL-UI.** CAT's own upload endpoints answer `410` (set `CAT_LEGACY_UPLOAD=1` to keep them).

Turn it on by layering the overlay and setting two addresses (use the host's tailnet IP, not `127.0.0.1`,
because containers of different compose projects cannot reach each other through loopback). In `.env`:

```
COMPOSE_FILE=docker-compose.yml:docker-compose.evil.yml
EVIL_UPLOAD_URL=http://100.122.165.58:8766     # EVIL's upload service
EVIL_UI_URL=http://cev-evil/                   # shown in "upload in EVIL" hints (optional)
```

and tell EVIL's worker where this pyworker is (in EVIL's `.env`): `EVIL_CAT_PYWORKER_URL=http://100.122.165.58:8000`.
The pyworker mounts EVIL's data volume read-only (`evil_evil-data` by default; override with `EVIL_DATA_VOLUME`).
Without `EVIL_UPLOAD_URL` CAT works exactly as before.

**One-time cleanup when switching** (CAT's old rows are unrelated to EVIL's recording ids and nothing needs
keeping): `docker compose exec db psql -U $DB_USER -d $DB_NAME -c "TRUNCATE rosbag_messages, rosbags, csv_uploads;"`.

### Tests

```bash
cd server && npm install && npm test                      # EVIL integration (node:test, no database)
cd client && CI=true npx react-scripts test --watchAll=false src/cachePrep.test.js
# pyworker: pure logic anywhere; the ROS and Postgres parts need ROS Humble and a Postgres
cd pyworker && python3 -m pytest tests                    # ROS/Postgres tests skip when unavailable
```
