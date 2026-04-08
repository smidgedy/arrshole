import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const CLI = resolve(import.meta.dirname, "../src/index.ts");

/**
 * Run the CLI with given args. Environment is stripped of QBIT_URL etc.
 * so config loading fails after arg parsing succeeds.
 */
function run(args: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(`node --import tsx ${CLI} ${args}`, {
      encoding: "utf-8",
      timeout: 10_000,
      env: {
        // Minimal env — no QBIT_URL so config loading will fail after arg parsing
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_NO_WARNINGS: "1",
      },
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      exitCode: err.status ?? 1,
    };
  }
}

describe("Startup error handling", () => {
  it("exits with config error when QBIT_URL is missing", () => {
    // DOTENV_CONFIG_PATH points to nonexistent file so .env isn't loaded
    try {
      execSync(`node --import tsx ${CLI} --now --stalled`, {
        encoding: "utf-8",
        timeout: 10_000,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          NODE_NO_WARNINGS: "1",
          DOTENV_CONFIG_PATH: "/tmp/.env.nonexistent",
        },
      });
      assert.fail("Should have exited with error");
    } catch (err: any) {
      assert.equal(err.status, 1);
      assert.ok(
        err.stderr.includes("QBIT_URL") || err.stderr.includes("failed to load configuration"),
        "Should report missing QBIT_URL",
      );
    }
  });

  it("exits with config error when no *arr app is configured", () => {
    try {
      execSync(`node --import tsx ${CLI} --now --stalled`, {
        encoding: "utf-8",
        timeout: 10_000,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          NODE_NO_WARNINGS: "1",
          DOTENV_CONFIG_PATH: "/tmp/.env.nonexistent",
          QBIT_URL: "http://localhost:8080",
          QBIT_USERNAME: "admin",
          QBIT_PASSWORD: "pass",
        },
      });
      assert.fail("Should have exited with error");
    } catch (err: any) {
      assert.equal(err.status, 1);
      assert.ok(
        err.stderr.includes("arr") || err.stderr.includes("configured"),
        "Should report missing *arr configuration",
      );
    }
  });
});

describe("CLI argument parsing", () => {
  it("--help outputs usage and exits 0", () => {
    const { stdout, exitCode } = run("--help");
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("arrshole"), "Should contain app name");
    assert.ok(stdout.includes("--now"), "Should document --now flag");
    assert.ok(stdout.includes("--stalled"), "Should document --stalled flag");
    assert.ok(stdout.includes("--metadl"), "Should document --metadl flag");
  });

  it("--now without --stalled or --metadl exits 1 with error", () => {
    const { stderr, exitCode } = run("--now");
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes("--now requires at least one of --stalled or --metadl"));
  });

  it("--stalled without --now exits 1 with error", () => {
    const { stderr, exitCode } = run("--stalled");
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes("require --now"));
  });

  it("--below 50 without --now exits 1", () => {
    const { stderr, exitCode } = run("--below 50");
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes("require --now"));
  });

  it("--below abc exits with error about invalid number", () => {
    const { stderr, exitCode } = run("--now --stalled --below abc");
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes("--below"));
    assert.ok(stderr.includes("abc"));
  });

  it("--below -1 exits with error", () => {
    const { stderr, exitCode } = run("--now --stalled --below -1");
    assert.equal(exitCode, 1);
    // parseArgs strict mode: -1 is interpreted as short flag -1 which is unknown
    // OR parsePercent rejects it — either way it should fail
  });

  it("--below 101 exits with error", () => {
    const { stderr, exitCode } = run("--now --stalled --below 101");
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes("--below"));
    assert.ok(stderr.includes("101"));
  });

  it("unknown flag --foo exits with error (strict mode)", () => {
    const { stderr, exitCode } = run("--foo");
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes("foo") || stderr.includes("Unknown"), "Should mention the unknown flag");
  });
});
