#!/usr/bin/env node
import { inspectHelmianCloudDeployment } from '../src/cloud/deployment-contract.mjs';

const result = inspectHelmianCloudDeployment(process.env);
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.ready ? 0 : 1;
