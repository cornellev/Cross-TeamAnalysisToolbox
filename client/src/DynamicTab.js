import React, { useState, useEffect, useRef, useCallback } from "react";
import Select from "react-select";
import UploadBag from "./UploadBag";
import { useCatConfig, useRecordingPrep, isReady, PrepareBanner, UploadNotice } from "./cachePrep";
import PointCloudPlayer from "./PointCloudPlayer";
import RawDataViewer from "./RawDataViewer";

const API_BASE = (process.env.REACT_APP_API_URL || "").replace(/\/$/, "");
const DEFAULT_STREAM_LIMIT = parseInt(
  process.env.REACT_APP_ROSBAG_CHUNK_SIZE || "250",
  10
);
const DEFAULT_BUFFER_LIMIT = parseInt(
  process.env.REACT_APP_ROSBAG_BUFFER_LIMIT || "250",
  10
);
const DEFAULT_DOWNSAMPLE_PERCENT = parseInt(
  process.env.REACT_APP_POINTCLOUD_PERCENT || "50",
  10
);

export default function DynamicTab() {
  const config = useCatConfig();
  const { prep, prepare } = useRecordingPrep(config.evil);
  const [bag, setBag] = useState(null);
  const [bagList, setBagList] = useState(null);
  const [selectedBag, setSelectedBag] = useState(null);
  const [topicOptions, setTopicOptions] = useState([]);
  const [selectedTopic, setSelectedTopic] = useState(null);
  const [JSONList, setJSONList] = useState([]);
  const [bufferStartIndex, setBufferStartIndex] = useState(0);
  const [currentFrameIndex, setCurrentFrameIndex] = useState(0);
  const [totalFrames, setTotalFrames] = useState(0);
  const [isStreamComplete, setIsStreamComplete] = useState(false);
  const [isBufferLoading, setIsBufferLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamStatus, setStreamStatus] = useState("");
  const [streamError, setStreamError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [frameLimit, setFrameLimit] = useState(DEFAULT_STREAM_LIMIT);
  const [bufferLimit, setBufferLimit] = useState(DEFAULT_BUFFER_LIMIT);
  const [downsamplePercent, setDownsamplePercent] = useState(
    Math.min(100, Math.max(1, DEFAULT_DOWNSAMPLE_PERCENT))
  );
  const toolOptions = [
    { value: "pointcloud", label: "Point Cloud" },
    { value: "raw", label: "Raw Data" },
  ];
  const [selectedTool, setSelectedTool] = useState(toolOptions[0]);

  const streamControllerRef = useRef(null);
  const frameMetaRef = useRef([]);
  const replayInitializedRef = useRef(false);

  const handleList = async (folderName) => {
    stopStreaming({ silent: true });
    resetPlayback();
    await fetchBagList();
    const option = folderName
      ? { label: folderName, value: folderName }
      : null;
    setSelectedBag(option);
    setBag(folderName || null);
  };
  const handleLoad = (state) => setIsLoading(state);

  const stopStreaming = ({ silent = false } = {}) => {
    const controller = streamControllerRef.current;
    if (controller) {
      controller.abort();
      streamControllerRef.current = null;
    }
    setIsStreaming(false);
    if (!silent) {
      setStreamStatus((prev) => prev || "Stream cancelled");
    }
  };

  const resetPlayback = () => {
    setJSONList([]);
    setBufferStartIndex(0);
    setCurrentFrameIndex(0);
    setTotalFrames(0);
    frameMetaRef.current = [];
    setIsStreamComplete(false);
    setStreamError(null);
    setStreamStatus("");
    replayInitializedRef.current = false;
  };

  const handleFrameLimitChange = (event) => {
    const value = Number(event.target.value);
    if (Number.isNaN(value)) {
      setFrameLimit(0);
      return;
    }
    const clamped = Math.max(1, Math.min(5000, value));
    setFrameLimit(clamped);
  };

  const handleBufferLimitChange = (event) => {
    const value = Number(event.target.value);
    if (Number.isNaN(value) || value <= 0) {
      setBufferLimit(50);
      return;
    }
    const clamped = Math.max(10, Math.min(2000, value));
    setBufferLimit(clamped);
  };

  const handleDownsampleChange = (event) => {
    const value = Number(event.target.value);
    if (Number.isNaN(value)) return;
    const clamped = Math.max(1, Math.min(100, value));
    setDownsamplePercent(clamped);
  };

  const handleBagSelect = (opt) => {
    stopStreaming({ silent: true });
    if (!opt) {
      setBag(null);
      setTopicOptions([]);
      setSelectedTopic(null);
      resetPlayback();
      return;
    }
    setBag(opt.value);
    resetPlayback();
    prepare(opt.value);
  };

  const fetchBagList = useCallback(async () => {
    try {
      const response = await fetch(API_BASE + "/api/rosbags");
      const data = await response.json();
      const options = data.map((bag) => ({
        label: bag.label || bag.folder_name,
        value: bag.folder_name,
      }));
      setBagList(options);
    } catch (error) {
      console.error("Failed to fetch bag list:", error);
    }
  }, []);

  const fetchTopics = async (folderName) => {
    if (!folderName) {
      setTopicOptions([]);
      setSelectedTopic(null);
      return;
    }

    try {
      const response = await fetch(
        `${API_BASE}/api/rosbags/${folderName}/topics`
      );
      const data = await response.json();
      const notDecoded = new Set(data.not_decoded || []);
      const options = (data.topics || []).map((topic) => ({
        label: notDecoded.has(topic) ? `${topic} (not decoded)` : topic,
        value: topic,
      }));

      setTopicOptions(options);
      const preferred =
        options.find((opt) => opt.value.toLowerCase().includes("pointcloud")) ||
        options[0] ||
        null;
      setSelectedTopic(preferred);
    } catch (error) {
      console.error("Failed to fetch topics:", error);
      setTopicOptions([]);
      setSelectedTopic(null);
    }
  };

  const startStreaming = async () => {
    if (!bag) {
      alert("Select a ROS bag first");
      return;
    }
    if (!selectedTopic) {
      alert("Select a topic to visualize");
      return;
    }

    stopStreaming({ silent: true });
    resetPlayback();
    setIsStreaming(true);
    setStreamStatus("Connecting...");

    const controller = new AbortController();
    streamControllerRef.current = controller;

    const params = new URLSearchParams();
    params.set("topic", selectedTopic.value);
    if (frameLimit > 0) {
      params.set("limit", String(frameLimit));
    }

    const handleLine = (line) => {
      if (!line) return;
      let payload;
      try {
        payload = JSON.parse(line);
      } catch (err) {
        console.warn("Skipping malformed stream chunk", err);
        return;
      }

      if (payload.type === "meta") {
        if (payload.status === "complete") {
          setStreamStatus("Stream complete");
          setIsStreamComplete(true);
        } else if (payload.status === "aborted") {
          setStreamStatus("Stream aborted");
        } else {
          const topicLabel =
            payload.topic || selectedTopic?.value || "selected topic";
          setStreamStatus(
            `Streaming ${topicLabel}${
              payload.limit ? ` (limit ${payload.limit})` : ""
            }`
          );
        }
        return;
      }

      if (payload.type === "error") {
        throw new Error(payload.message || "Stream error");
      }

      const frameIndex = frameMetaRef.current.length;
      frameMetaRef.current.push({ index: frameIndex, timestamp: payload.timestamp });
      setTotalFrames(frameIndex + 1);

      setJSONList((prev) => {
        const next = [...prev, payload];
        if (bufferLimit > 0 && next.length > bufferLimit) {
          const overflow = next.length - bufferLimit;
          setBufferStartIndex((prevStart) => {
            const newStart = prevStart + overflow;
            setCurrentFrameIndex((prevIndex) =>
              prevIndex < newStart ? newStart : prevIndex
            );
            return newStart;
          });
          return next.slice(overflow);
        }
        return next;
      });
      setCurrentFrameIndex(frameIndex);
    };

    const consumeBuffer = (decoder, reader) => {
      let buffer = "";

      const flushBuffer = (final = false) => {
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          handleLine(line);
        }
        if (final) {
          const trailing = buffer.trim();
          if (trailing) {
            handleLine(trailing);
          }
          buffer = "";
        }
      };

      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (value) {
              buffer += decoder.decode(value, { stream: true });
              flushBuffer();
            }
            if (done) break;
          }
          buffer += decoder.decode();
          flushBuffer(true);
        } catch (err) {
          throw err;
        }
      };

      return pump();
    };

    try {
      const response = await fetch(
        `${API_BASE}/api/rosbags/${bag}/stream?${params.toString()}`,
        {
          signal: controller.signal,
          headers: { Accept: "application/x-ndjson" },
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to stream rosbag (${response.status})`);
      }

      if (!response.body) {
        throw new Error("Streaming is not supported by this browser");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      await consumeBuffer(decoder, reader);

      setStreamStatus((prev) => prev || "Stream complete");
    } catch (error) {
      if (controller.signal.aborted) {
        setStreamStatus("Stream cancelled");
      } else {
        console.error("Error streaming bag data:", error);
        setStreamError(error.message);
        setStreamStatus("Stream failed");
      }
    } finally {
      if (streamControllerRef.current === controller) {
        streamControllerRef.current = null;
      }
      setIsStreaming(false);
    }
  };

  const loadBufferAtIndex = async (targetIndex) => {
    if (!bag || !selectedTopic) return false;
    const metadata = frameMetaRef.current;
    if (!metadata[targetIndex]) {
      console.warn("Frame metadata unavailable for index", targetIndex);
      return false;
    }

    const chunkSize = bufferLimit || DEFAULT_STREAM_LIMIT;
    const total = metadata.length;
    const maxStart = Math.max(total - chunkSize, 0);
    const startIndex = Math.max(
      0,
      Math.min(targetIndex - Math.floor(chunkSize / 2), maxStart)
    );
    const cursorTimestamp =
      startIndex === 0 ? null : metadata[startIndex - 1]?.timestamp;

    const params = new URLSearchParams();
    params.set("topic", selectedTopic.value);
    params.set("limit", String(chunkSize));
    if (cursorTimestamp) {
      params.set("cursor", cursorTimestamp);
    }

    setIsBufferLoading(true);
    stopStreaming({ silent: true });

    try {
      const response = await fetch(
        `${API_BASE}/api/rosbags/${bag}?${params.toString()}`
      );
      if (!response.ok) {
        throw new Error(`Failed to load frames (${response.status})`);
      }
      const payload = await response.json();
      const rows = payload.messages || [];
      setBufferStartIndex(startIndex);
      setJSONList(rows);
      setCurrentFrameIndex(targetIndex);
      setTotalFrames(frameMetaRef.current.length);
      return true;
    } catch (error) {
      console.error("Failed to load frame chunk:", error);
      setStreamError(error.message || "Failed to load frame chunk");
      return false;
    } finally {
      setIsBufferLoading(false);
    }
  };

  const handleFrameChange = async (targetIndex) => {
    if (typeof targetIndex !== "number" || Number.isNaN(targetIndex)) return;
    const bufferEnd = bufferStartIndex + (JSONList?.length || 0);
    if (
      targetIndex >= bufferStartIndex &&
      targetIndex < bufferEnd &&
      JSONList.length
    ) {
      setCurrentFrameIndex(targetIndex);
      return;
    }

    if (!isStreamComplete) {
      console.warn("Cannot seek outside buffer until streaming completes");
      return;
    }

    await loadBufferAtIndex(targetIndex);
  };

  useEffect(() => {
    fetchBagList();
  }, [fetchBagList]);

  useEffect(() => {
    return () => stopStreaming({ silent: true });
  }, []);

  useEffect(() => {
    if (!bag) return;
    // with EVIL, topics exist only once the recording's cache is built
    if (!isReady(prep, bag, config.evil)) return;
    fetchTopics(bag);
  }, [bag, prep.status, prep.id, config.evil]);

  useEffect(() => {
    if (!bufferLimit || JSONList.length <= bufferLimit) return;
    const overflow = JSONList.length - bufferLimit;
    setJSONList((prev) => prev.slice(overflow));
    setBufferStartIndex((prevStart) => {
      const newStart = prevStart + overflow;
      setCurrentFrameIndex((prevIndex) =>
        prevIndex < newStart ? newStart : prevIndex
      );
      return newStart;
    });
  }, [bufferLimit, JSONList.length]);

  useEffect(() => {
    if (
      isStreamComplete &&
      totalFrames > 0 &&
      !replayInitializedRef.current
    ) {
      replayInitializedRef.current = true;
      if (bufferStartIndex === 0) {
        setCurrentFrameIndex(0);
      } else {
        loadBufferAtIndex(0);
      }
    }
  }, [
    isStreamComplete,
    totalFrames,
    bufferStartIndex,
    loadBufferAtIndex,
  ]);

  useEffect(() => {
    if (!bufferLimit || bufferLimit <= 0) return;
    setJSONList((prev) =>
      prev.length > bufferLimit ? prev.slice(prev.length - bufferLimit) : prev
    );
  }, [bufferLimit]);

  return (
    <div className="parent">
      <div className="left-pane">
        {config.legacy_upload ? (
          <UploadBag onUploadComplete={handleList} loading={handleLoad} />
        ) : (
          <UploadNotice url={config.evil_ui_url} />
        )}

        <Select
          options={bagList || []}
          onChange={handleBagSelect}
          isDisabled={isLoading || isStreaming}
          placeholder="Select a ROSBag to visualize"
        />
        <PrepareBanner prep={prep} />

        <Select
          options={topicOptions}
          value={selectedTopic}
          onChange={(opt) => {
            stopStreaming({ silent: true });
            setSelectedTopic(opt);
            resetPlayback();
          }}
          isDisabled={isLoading || isStreaming || !topicOptions.length}
          placeholder="Select a topic"
          styles={{ menu: (base) => ({ ...base, zIndex: 20 }) }}
        />

        <div className="input-grid">
          <label className="input-label" htmlFor="frame-limit-input">
            Max frames per stream
            <input
              id="frame-limit-input"
              type="number"
              min={1}
              max={5000}
              value={frameLimit}
              onChange={handleFrameLimitChange}
              disabled={isStreaming}
            />
            <small>Applies to the next stream request.</small>
          </label>

          <label className="input-label" htmlFor="buffer-limit-input">
            Buffer window (frames kept in memory)
            <input
              id="buffer-limit-input"
              type="number"
              min={10}
              max={2000}
              value={bufferLimit}
              onChange={handleBufferLimitChange}
            />
            <small>
              Playback works inside this rolling window. Larger values consume more
              RAM.
            </small>
          </label>

          <label className="input-label" htmlFor="downsample-percent-input">
            Downsample (% of points kept per frame)
            <input
              id="downsample-percent-input"
              type="number"
              min={1}
              max={100}
              value={downsamplePercent}
              onChange={handleDownsampleChange}
            />
            <small>
              100% keeps every point. Lower values decode fewer points for faster
              playback.
            </small>
          </label>
        </div>

        <button
          onClick={startStreaming}
          className="button-css"
          disabled={isLoading || isStreaming || !isReady(prep, bag, config.evil)}
        >
          {isStreaming ? "Streaming…" : "Stream and Visualize"}
        </button>

        {isStreaming && (
          <button onClick={() => stopStreaming()} className="button-css">
            Stop Stream
          </button>
        )}

        {(isLoading || isStreaming) && <div className="spinner"></div>}

        <div className="stream-status">
          {streamStatus && <div>{streamStatus}</div>}
          {streamError && (
            <div style={{ color: "#ff5252" }}>Error: {streamError}</div>
          )}
          {isBufferLoading && <div>Loading frame window…</div>}
          {!!JSONList.length && (
            <div>
              Buffered {JSONList.length}
              {bufferLimit ? ` / ${bufferLimit}` : ""} frame
              {JSONList.length === 1 ? "" : "s"}
            </div>
          )}
        </div>
      </div>

      <div className="right-pane">
        <Select
          options={toolOptions}
          value={selectedTool}
          onChange={(opt) => setSelectedTool(opt || toolOptions[0])}
          isDisabled={isLoading}
        />
        {selectedTool?.value === "raw" ? (
          <RawDataViewer frames={JSONList || []} />
        ) : (
          <PointCloudPlayer
            jsonFrames={JSONList || []}
            downsamplePercent={downsamplePercent}
            bufferStartIndex={bufferStartIndex}
            totalFrames={totalFrames}
            currentFrameIndex={currentFrameIndex}
            onFrameChange={handleFrameChange}
            isBufferLoading={isBufferLoading}
          />
        )}
      </div>
    </div>
  );
}
