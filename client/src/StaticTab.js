import React, { useEffect, useState } from "react";
import Select from "react-select";
import UploadCsv from "./UploadCsv";
import { useCatConfig, useRecordingPrep, isReady, PrepareBanner, UploadNotice } from "./cachePrep";

const API_BASE = (process.env.REACT_APP_API_URL || "").replace(/\/$/, "");
const EV_URL = `${(process.env.REACT_APP_SHINY_URL || "/ev/").replace(
  /\/+$/,
  ""
)}/`;

const isAbsoluteUrl = (url) => /^https?:\/\//i.test(url);

export default function StaticTab() {
  const config = useCatConfig();
  const csvPrep = useRecordingPrep(config.evil);
  const bagPrep = useRecordingPrep(config.evil);
  const [csvList, setCsvList] = useState([]);
  const [selectedCsv, setSelectedCsv] = useState(null);
  const [bagList, setBagList] = useState([]);
  const [selectedBag, setSelectedBag] = useState(null);
  const [bagMessages, setBagMessages] = useState([]);
  const [topics, setTopics] = useState([]);
  const [selectedTopic, setSelectedTopic] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  // Fetch all CSVs
  const fetchCsvList = async () => {
    try {
      const response = await fetch(`${API_BASE}/api/csv`);
      const data = await response.json();
      setCsvList(
        data.map((csv) => ({
          label: csv.label || csv.name,
          value: csv.name,
        }))
      );
    } catch (err) {
      console.error("Failed to fetch CSV list:", err);
    }
  };

  useEffect(() => {
    fetchCsvList();
  }, []);

  // fetch rosbag list from backend
  const fetchBagList = async () => {
    try {
      const response = await fetch(`${API_BASE}/api/rosbags`);
      const data = await response.json();
      setBagList(
        data.map((bag) => ({
          label: bag.label || bag.folder_name,
          value: bag.folder_name,
        }))
      );
    } catch (err) {
      console.error("Failed to fetch bag list:", err);
    }
  };

  useEffect(() => {
    fetchBagList();
  }, []);

  useEffect(() => {
    const fetchTopics = async () => {
      if (!selectedBag) return;
      if (!isReady(bagPrep.prep, selectedBag.value, config.evil)) return;
      try {
        const response = await fetch(
          `${API_BASE}/api/rosbags/${selectedBag.value}/topics`
        );
        const data = await response.json();
        setTopics(data.topics.map((t) => ({ label: t, value: t })));
      } catch (err) {
        console.error("Failed to fetch topics:", err);
        setTopics([]);
      }
    };
    fetchTopics();
  }, [selectedBag, bagPrep.prep.status, bagPrep.prep.id, config.evil]);

  // handle visualize button click
  const handleVisualize = () => {
    if (!selectedCsv) return;

    const iframe = document.querySelector("iframe[title='Run Data Analysis']");
    if (!iframe) return;

    setIsLoading(true);
    iframe.src = ""; // force clear

    setTimeout(() => {
      iframe.src = EV_URL;

      iframe.onload = () => {
        setIsLoading(false);
        console.log("Sending CSV name to Shiny:", selectedCsv.value);

        // Extract only the origin (scheme + host + port)
        const shinyOrigin = isAbsoluteUrl(EV_URL)
          ? new URL(EV_URL).origin
          : window.location.origin;
        console.log("iframe origin:", iframe.src);

        iframe.contentWindow.postMessage(
          { type: "load_csv", csv: selectedCsv.value },
          shinyOrigin
        );

        // fallback if Shiny not ready yet
        iframe.contentWindow.postMessage(
          { type: "load_csv", csv: selectedCsv.value },
          "*"
        );
      };
    }, 150);
  };

  const handleRosbagVisualize = () => {
    if (!selectedBag || !selectedTopic) return;

    const iframe = document.querySelector("iframe[title='Run Data Analysis']");
    if (!iframe) return;

    setIsLoading(true);
    iframe.src = ""; // force refresh

    setTimeout(() => {
      iframe.src = EV_URL;

      iframe.onload = () => {
        setIsLoading(false);
        console.log(
          "Sending ROSBag + topic to Shiny:",
          selectedBag.value,
          selectedTopic.value
        );

        const shinyOrigin = isAbsoluteUrl(EV_URL)
          ? new URL(EV_URL).origin
          : window.location.origin;
        iframe.contentWindow.postMessage(
          {
            type: "load_rosbag",
            bag: selectedBag.value,
            topic: selectedTopic.value,
          },
          shinyOrigin
        );

        // fallback
        iframe.contentWindow.postMessage(
          {
            type: "load_rosbag",
            bag: selectedBag.value,
            topic: selectedTopic.value,
          },
          "*"
        );
      };
    }, 150);
  };

  return (
    <>
      {/* Compact styling injected directly */}
      <style>
        {`
        .left-pane {
          font-size: 0.85rem; 
        }
        .left-pane h3 {
          font-size: 1rem;
        }
        .button-css {
          font-size: 0.8rem;
          padding: 6px 10px;
        }
        .error-text {
          font-size: 0.8rem;
        }
        .left-pane .Select__control,
        .left-pane .react-select__control {
          font-size: 0.85rem;
        }
      `}
      </style>

      <div className="parent">
        <div className="left-pane">
          {/* CSV Upload Section */}
          <h3 style={{ color: "white", marginBottom: "12px" }}>
            CSV Upload & Visualization
          </h3>

          {config.legacy_upload ? (
            <UploadCsv
              onUploadComplete={() => {
                fetchCsvList();
              }}
              loading={setIsLoading}
            />
          ) : (
            <UploadNotice url={config.evil_ui_url} />
          )}

          <Select
            options={csvList}
            value={selectedCsv}
            onChange={(opt) => {
              setSelectedCsv(opt);
              csvPrep.prepare(opt ? opt.value : null);
            }}
            isDisabled={isLoading}
            placeholder="Select a CSV file"
            styles={{
              container: (base) => ({ ...base, marginTop: "10px" }),
            }}
          />
          <PrepareBanner prep={csvPrep.prep} />

          <button
            onClick={handleVisualize}
            className="button-css"
            disabled={
              !selectedCsv ||
              isLoading ||
              !isReady(csvPrep.prep, selectedCsv && selectedCsv.value, config.evil)
            }
          >
            {isLoading ? "Loading..." : "Fetch & Visualize CSV"}
          </button>

          {/* ROSBag Section */}
          <h3 style={{ color: "white", margin: "20px 0 12px 0" }}>
            ROSBag Visualization
          </h3>

          <Select
            options={bagList}
            value={selectedBag}
            onChange={(opt) => {
              setSelectedBag(opt);
              setSelectedTopic(null);
              setTopics([]);
              bagPrep.prepare(opt ? opt.value : null);
            }}
            isDisabled={isLoading}
            placeholder="Select a ROSBag"
          />
          <PrepareBanner prep={bagPrep.prep} />

          <Select
            options={topics}
            value={selectedTopic}
            onChange={setSelectedTopic}
            isDisabled={!selectedBag || isLoading}
            placeholder="Select a Topic"
          />

          <button
            onClick={handleRosbagVisualize}
            className="button-css"
            disabled={!selectedBag || !selectedTopic || isLoading}
          >
            {isLoading ? "Loading..." : "Fetch & Visualize ROSBag"}
          </button>

          {isLoading && <div className="spinner" />}
          {error && (
            <div
              className="error-text"
              style={{ color: "red", marginTop: "10px" }}
            >
              {error}
            </div>
          )}
        </div>

        <div className="right-pane">
          <iframe
            title="Run Data Analysis"
            src={EV_URL}
            style={{
              width: "100%",
              height: "100%",
              border: "none",
              background: "#fff",
            }}
          />
        </div>
      </div>
    </>
  );
}
