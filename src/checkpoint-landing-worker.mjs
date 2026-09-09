// SPDX-License-Identifier: FSL-1.1-MIT
/** Bundled entry point; runWorkspaceCommand supervises this process and every Git descendant. */
import { performCheckpointLanding, writeLandingWorkerResult } from './checkpoint-landing.mjs';

const id = process.argv[2];
if (!/^[0-9a-f]{64}$/.test(id ?? '')) throw new Error('A private landing transaction id is required.');
let result;
try { result = await performCheckpointLanding(process.cwd(), id); }
catch (error) { result = { ok: false, code: 'landing-interrupted', landingId: id, reason: error.message }; }
await writeLandingWorkerResult(process.cwd(), id, result);
process.exitCode = result.ok ? 0 : 2;
