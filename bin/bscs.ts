#!/usr/bin/env tsx
import { createProgram } from '../src/cli/index.js';

const program = createProgram();
program.parse(process.argv);
