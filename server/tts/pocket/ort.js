// Ambition shim for upstream "#ort". onnxruntime-node is installed on the box under
// AMBITION_TTS_DIR\node_modules (not in server/package.json, so the lockfile stays untouched);
// fall back to normal resolution for dev machines.
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = process.env.AMBITION_TTS_DIR || 'D:\\ambition\\tts';
let m;
try { m = await import(pathToFileURL(createRequire(path.join(dir, 'x.js')).resolve('onnxruntime-node')).href); }
catch { m = await import('onnxruntime-node'); }
const ort = m.default ?? m;
export const Tensor = ort.Tensor;
export const InferenceSession = ort.InferenceSession;
export default ort;
