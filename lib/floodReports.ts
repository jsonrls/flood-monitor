import { getApp, getApps, initializeApp } from "firebase/app";
import {
  type Firestore,
  GeoPoint,
  Timestamp,
  addDoc,
  collection,
  doc,
  getFirestore,
  increment,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc
} from "firebase/firestore";
import { type Auth, getAuth, signInAnonymously } from "firebase/auth";

export const FLOOD_DEPTHS = ["none", "ankle", "knee", "waist", "chest"] as const;
export const VEHICLE_ACCESS_LEVELS = ["passable", "difficult", "impassable"] as const;

export type FloodDepth = (typeof FLOOD_DEPTHS)[number];
export type VehicleAccess = (typeof VEHICLE_ACCESS_LEVELS)[number];
export type FloodReportSelectionMethod = "device-location" | "map-pin";

export type FloodReportLocation = {
  latitude: number;
  longitude: number;
  accuracyM: number;
  areaLabel: string;
  selectionMethod: FloodReportSelectionMethod;
};

export type FloodReport = FloodReportLocation & {
  id: string;
  depth: FloodDepth;
  vehicleAccess: VehicleAccess;
  status: "active" | "clear";
  createdAt: Date;
  expiresAt: Date;
  stillFloodedCount?: number;
  clearedCount?: number;
};

export type NewFloodReport = FloodReportLocation & {
  depth: FloodDepth;
  vehicleAccess: VehicleAccess;
};

type FirebaseClientError = {
  code?: unknown;
};

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID
};

export const isFirebaseConfigured = Object.values(firebaseConfig).every(
  (value) => typeof value === "string" && value.length > 0
);

let cachedFirestore: Firestore | null = null;
let cachedAuth: Auth | null = null;

const getFirebaseServices = () => {
  if (!isFirebaseConfigured) {
    throw new Error("Flood reporting is not configured yet. Add the Firebase public web configuration and restart the app.");
  }

  const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
  cachedFirestore ??= getFirestore(app);
  cachedAuth ??= getAuth(app);

  return { auth: cachedAuth, firestore: cachedFirestore };
};

const isFloodDepth = (value: unknown): value is FloodDepth =>
  typeof value === "string" && FLOOD_DEPTHS.includes(value as FloodDepth);

const isVehicleAccess = (value: unknown): value is VehicleAccess =>
  typeof value === "string" && VEHICLE_ACCESS_LEVELS.includes(value as VehicleAccess);

const toDate = (value: unknown) => (value instanceof Timestamp ? value.toDate() : null);

export const getFloodReportSubmissionErrorMessage = (error: unknown) => {
  const code = typeof error === "object" && error !== null
    ? (error as FirebaseClientError).code
    : undefined;

  switch (code) {
    case "auth/admin-restricted-operation":
      return "Community reporting is unavailable because Firebase user sign-up is disabled.";
    case "auth/operation-not-allowed":
      return "Community reporting is unavailable because Firebase Anonymous Authentication is disabled.";
    case "permission-denied":
    case "firestore/permission-denied":
      return "Firebase rejected the report. The latest Firestore security rules may not be deployed.";
    case "auth/network-request-failed":
    case "unavailable":
    case "firestore/unavailable":
      return "The report could not reach Firebase. Check your connection and try again.";
    default:
      return "The report could not be sent. Please try again.";
  }
};

export const subscribeToFloodReports = (
  onReports: (reports: FloodReport[]) => void,
  onError: (message: string) => void
) => {
  if (!isFirebaseConfigured) return () => undefined;

  const { firestore } = getFirebaseServices();
  const recentReportsQuery = query(
    collection(firestore, "floodReports"),
    orderBy("createdAt", "desc"),
    limit(250)
  );

  return onSnapshot(
    recentReportsQuery,
    (snapshot) => {
      const now = Date.now();
      const reports = snapshot.docs.flatMap((document) => {
        const data = document.data();
        const createdAt = toDate(data.createdAt);
        const expiresAt = toDate(data.expiresAt);
        const location = data.location instanceof GeoPoint ? data.location : null;

        if (
          !createdAt ||
          !expiresAt ||
          expiresAt.getTime() <= now ||
          !location ||
          !isFloodDepth(data.depth) ||
          !isVehicleAccess(data.vehicleAccess) ||
          typeof data.areaLabel !== "string" ||
          (data.status !== "active" && data.status !== "clear")
        ) {
          return [];
        }

        const stillFloodedCount =
          typeof data.stillFloodedCount === "number" ? Math.max(0, data.stillFloodedCount) : 1;
        const clearedCount =
          typeof data.clearedCount === "number" ? Math.max(0, data.clearedCount) : 0;

        return [{
          id: document.id,
          latitude: location.latitude,
          longitude: location.longitude,
          accuracyM: typeof data.accuracyM === "number" ? data.accuracyM : 0,
          areaLabel: data.areaLabel,
          selectionMethod: data.selectionMethod === "device-location" ? "device-location" : "map-pin",
          depth: data.depth,
          vehicleAccess: data.vehicleAccess,
          status: data.status,
          createdAt,
          expiresAt,
          stillFloodedCount,
          clearedCount
        } satisfies FloodReport];
      });

      onReports(reports);
    },
    (error) => onError(error.message || "Community flood reports are temporarily unavailable.")
  );
};

export const submitFloodReport = async (report: NewFloodReport) => {
  const { auth, firestore } = getFirebaseServices();

  if (!auth.currentUser) {
    await signInAnonymously(auth);
  }

  const now = Date.now();
  const reportDocument = await addDoc(collection(firestore, "floodReports"), {
    schemaVersion: 1,
    source: "public-web",
    location: new GeoPoint(report.latitude, report.longitude),
    latitude: report.latitude,
    longitude: report.longitude,
    accuracyM: Math.max(0, Math.min(Math.round(report.accuracyM), 10_000)),
    areaLabel: report.areaLabel.slice(0, 160),
    selectionMethod: report.selectionMethod,
    depth: report.depth,
    vehicleAccess: report.vehicleAccess,
    status: report.depth === "none" ? "clear" : "active",
    stillFloodedCount: 1,
    clearedCount: 0,
    createdAt: serverTimestamp(),
    expiresAt: Timestamp.fromMillis(now + 24 * 60 * 60 * 1000)
  });

  return reportDocument.id;
};

export const confirmFloodReport = async (
  reportId: string,
  vote: "still-flooded" | "cleared"
) => {
  if (!isFirebaseConfigured) return;

  try {
    const { auth, firestore } = getFirebaseServices();

    if (!auth.currentUser) {
      await signInAnonymously(auth);
    }

    const reportRef = doc(firestore, "floodReports", reportId);
    if (vote === "still-flooded") {
      const now = Date.now();
      await updateDoc(reportRef, {
        stillFloodedCount: increment(1),
        expiresAt: Timestamp.fromMillis(now + 24 * 60 * 60 * 1000)
      });
    } else {
      await updateDoc(reportRef, {
        clearedCount: increment(1)
      });
    }
  } catch (error) {
    console.warn("Could not record confirmation to Firebase:", error);
  }
};

