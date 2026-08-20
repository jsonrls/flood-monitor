"use client";

import { useEffect, useRef } from "react";
import type { FloodDepth, FloodReportLocation, VehicleAccess } from "@/lib/floodReports";

type FloodReportDialogProps = {
  location: FloodReportLocation;
  depth: FloodDepth | null;
  vehicleAccess: VehicleAccess | null;
  isSubmitting: boolean;
  submitted: boolean;
  error: string | null;
  onClose: () => void;
  onEditLocation: () => void;
  onDepthChange: (depth: FloodDepth) => void;
  onVehicleAccessChange: (vehicleAccess: VehicleAccess) => void;
  onSubmit: () => void;
};

const DEPTH_OPTIONS: ReadonlyArray<{ value: FloodDepth; label: string; color: string }> = [
  { value: "none", label: "No flooding", color: "#48b77b" },
  { value: "ankle", label: "Ankle deep", color: "#50c8bb" },
  { value: "knee", label: "Knee deep", color: "#f1b934" },
  { value: "waist", label: "Waist deep", color: "#ed8b3c" },
  { value: "chest", label: "Chest deep or higher", color: "#d94640" }
];

const VEHICLE_OPTIONS: ReadonlyArray<{ value: VehicleAccess; label: string }> = [
  { value: "passable", label: "Passable" },
  { value: "difficult", label: "Difficult" },
  { value: "impassable", label: "Impassable" }
];

export default function FloodReportDialog({
  location,
  depth,
  vehicleAccess,
  isSubmitting,
  submitted,
  error,
  onClose,
  onEditLocation,
  onDepthChange,
  onVehicleAccessChange,
  onSubmit
}: FloodReportDialogProps) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  return (
    <div
      className="flood-report-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isSubmitting) onClose();
      }}
    >
      <section
        className="flood-report-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="flood-report-dialog-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !isSubmitting) onClose();
        }}
      >
        <header className="flood-report-dialog-header">
          <div>
            <span>Community field report</span>
            <h2 id="flood-report-dialog-title">{submitted ? "Report received" : "Report flooding"}</h2>
            <p>{submitted ? "Your update is now visible on the map." : "Takes about fifteen seconds. No account needed."}</p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            aria-label="Close flood report"
          >
            ×
          </button>
        </header>

        {submitted ? (
          <div className="flood-report-success" role="status">
            <span className="flood-report-success-mark" aria-hidden="true">✓</span>
            <strong>Thanks for helping Albay stay informed.</strong>
            <p>Reports remain on the community layer for 24 hours so the map reflects current conditions.</p>
            <button type="button" onClick={onClose}>Back to the map</button>
          </div>
        ) : (
          <div className="flood-report-dialog-body">
            <div className="flood-report-field">
              <div className="flood-report-field-heading">
                <label>Location</label>
                <button type="button" onClick={onEditLocation} disabled={isSubmitting}>Edit pin</button>
              </div>
              <div className="flood-report-location-card">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 21s7-6.2 7-12A7 7 0 1 0 5 9c0 5.8 7 12 7 12Z" />
                  <circle cx="12" cy="9" r="2.4" />
                </svg>
                <span>
                  <strong>{location.areaLabel}</strong>
                  <small>{location.latitude.toFixed(5)}, {location.longitude.toFixed(5)}</small>
                  <small>
                    {location.selectionMethod === "device-location"
                      ? `Device location • ±${Math.max(1, Math.round(location.accuracyM))} m reported accuracy`
                      : "Location adjusted manually"}
                  </small>
                </span>
              </div>
            </div>

            <fieldset className="flood-report-field flood-depth-options">
              <legend>How deep?</legend>
              <div>
                {DEPTH_OPTIONS.map((option) => (
                  <label key={option.value} className={depth === option.value ? "is-selected" : ""}>
                    <input
                      type="radio"
                      name="flood-depth"
                      value={option.value}
                      checked={depth === option.value}
                      onChange={() => onDepthChange(option.value)}
                      disabled={isSubmitting}
                    />
                    <span className="flood-depth-dot" style={{ backgroundColor: option.color }} aria-hidden="true" />
                    <span>{option.label}</span>
                    <span className="flood-report-option-check" aria-hidden="true">✓</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="flood-report-field flood-vehicle-options">
              <legend>Can vehicles pass?</legend>
              <div>
                {VEHICLE_OPTIONS.map((option) => (
                  <label key={option.value} className={vehicleAccess === option.value ? "is-selected" : ""}>
                    <input
                      type="radio"
                      name="vehicle-access"
                      value={option.value}
                      checked={vehicleAccess === option.value}
                      onChange={() => onVehicleAccessChange(option.value)}
                      disabled={isSubmitting}
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            {error ? <p className="flood-report-error" role="alert">{error}</p> : null}

            <button
              type="button"
              className="flood-report-submit"
              onClick={onSubmit}
              disabled={!depth || !vehicleAccess || isSubmitting}
            >
              {isSubmitting ? "Sending report…" : "Submit report"}
            </button>
            <p className="flood-report-privacy-note">
              Only the selected map point and the answers above are shared. Your device location is never requested until you start a report.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
