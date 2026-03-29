import { Command } from 'commander';
import { createFleetInitCommand, createFleetImportCommand } from './init.js';
import { createFleetStatusCommand, createFleetReconcileCommand } from './status.js';

export function createFleetCommand(): Command {
  const command = new Command('fleet')
    .description('Manage the agent fleet');
  
  command.addCommand(createFleetInitCommand());
  command.addCommand(createFleetImportCommand());
  command.addCommand(createFleetStatusCommand());
  command.addCommand(createFleetReconcileCommand());
  
  return command;
}

// Re-export for use by other modules
export { getFleetStatus, type FleetStatusResult, type FleetAgentStatus } from './status.js';
