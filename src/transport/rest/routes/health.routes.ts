import { Router } from "express";
import mongoose from "mongoose";

export function createHealthRouter(): Router {
  const router = Router();

  router.get("/", (req, res) => {
    const mongoState = mongoose.connection.readyState;
    const mongoStatusMap: Record<number, string> = {
      0: "disconnected",
      1: "connected",
      2: "connecting",
      3: "disconnecting",
    };

    res.json({
      status: "ok",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      services: {
        mongodb: mongoStatusMap[mongoState] || "unknown",
      },
    });
  });

  return router;
}
