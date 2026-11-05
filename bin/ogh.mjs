#!/usr/bin/env node
// Entry point: runs the TypeScript sources through tsx so there is no build step for the server.
import { register } from 'tsx/esm/api';

register();
await import('../src/server/cli.ts');
