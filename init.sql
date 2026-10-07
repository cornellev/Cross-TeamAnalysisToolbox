CREATE TABLE rosbag_messages (
    id SERIAL PRIMARY KEY,
    bag_name TEXT NOT NULL,
    topic TEXT NOT NULL,
    timestamp BIGINT NOT NULL,
    data JSONB NOT NULL
);

CREATE INDEX idx_rosbag_bag ON rosbag_messages(bag_name);
CREATE INDEX idx_rosbag_time ON rosbag_messages(timestamp);

CREATE TABLE rosbags (
    id SERIAL PRIMARY KEY,
    folder_name TEXT NOT NULL UNIQUE,
    yaml_data JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE csv_uploads (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,   
    headers TEXT[] NOT NULL,
    data JSONB NOT NULL,      
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Phase 4 (CAT as a cache of EVIL's recordings): which topics of a cached bag were stored undecoded
-- because their message type is not installed in the pyworker. Also created idempotently by
-- pyworker/cache_sink.py, since an existing database never re-runs this file.
CREATE TABLE IF NOT EXISTS cache_topics (
    bag_name TEXT NOT NULL,
    topic TEXT NOT NULL,
    type TEXT,
    msg_count BIGINT,
    decoded BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (bag_name, topic)
);
