import { describe, it, expect } from "vitest";
import { parseCodexDeviceAuth } from "../lib/codex-device-auth.js";

const ESC = "";

const REAL = [
  "Welcome to Codex [v0.130.0]",
  `${ESC}[90mOpenAI's command-line coding agent${ESC}[0m`,
  "",
  "Follow these steps to sign in with ChatGPT using device code authorization:",
  "",
  "1. Open this link in your browser and sign in to your account",
  `   ${ESC}[94mhttps://auth.openai.com/codex/device${ESC}[0m`,
  "",
  `2. Enter this one-time code ${ESC}[90m(expires in 15 minutes)${ESC}[0m`,
  `   ${ESC}[94m5BLJ-IWPLN${ESC}[0m`,
  "",
  `${ESC}[90mDevice codes are a common phishing target. Never share this code.${ESC}[0m`,
].join("\n");

describe("parseCodexDeviceAuth", () => {
  it("extracts url + code + expiry from the real ANSI-coded output", () => {
    expect(parseCodexDeviceAuth(REAL)).toEqual({
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "5BLJ-IWPLN",
      expiresInMinutes: 15,
    });
  });

  it("works on clean (ANSI-stripped) output too", () => {
    // eslint-disable-next-line no-control-regex -- ANSI ESC strip in fixture
    const clean = REAL.replace(/\[[0-9;]*m/g, "");
    expect(parseCodexDeviceAuth(clean)).toEqual({
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "5BLJ-IWPLN",
      expiresInMinutes: 15,
    });
  });

  it("handles other code shapes / a singular minute", () => {
    const s =
      "Open this link: https://auth.openai.com/codex/device\nEnter this one-time code (expires in 1 minute)\nABCD-1234";
    expect(parseCodexDeviceAuth(s)).toEqual({
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1234",
      expiresInMinutes: 1,
    });
  });

  it("returns expiresInMinutes:null when expiry text is absent", () => {
    const s = "visit https://auth.openai.com/codex/device\ncode: WXYZ-7Q2K";
    expect(parseCodexDeviceAuth(s)).toEqual({
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "WXYZ-7Q2K",
      expiresInMinutes: null,
    });
  });

  it("returns null when it is not a device-auth prompt", () => {
    expect(parseCodexDeviceAuth("Logged in using ChatGPT")).toBeNull();
    expect(parseCodexDeviceAuth("")).toBeNull();
    
    expect(
      parseCodexDeviceAuth("Open https://auth.openai.com/codex/device and wait"),
    ).toBeNull();
  });
});
