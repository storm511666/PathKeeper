/**
 * Every renderer -> main channel. Keep this list in sync with:
 *  - src/preload/index.ts
 *  - src/main/ipc.ts
 */
export const IPC = {
  projectsList: 'projects:list',
  projectsAdd: 'projects:add',
  projectsAddFromPath: 'projects:add-from-path',
  projectsRemove: 'projects:remove',
  projectsRename: 'projects:rename',
  projectsReveal: 'projects:reveal',
  projectsLoadSample: 'projects:load-sample',

  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',

  pathsPreview: 'paths:preview',

  autoCheckRun: 'autocheck:run',

  dependenciesScan: 'dependencies:scan',
  dependenciesChanges: 'dependencies:changes',
  dependenciesWatchStart: 'dependencies:watch-start',
  dependenciesWatchStop: 'dependencies:watch-stop',
  dependenciesValidateFix: 'dependencies:validate-fix',
  dependenciesRepair: 'dependencies:repair',
  dependenciesRebuildCache: 'dependencies:rebuild-cache',
  dependenciesIgnore: 'dependencies:ignore',
  dependenciesChanged: 'dependencies:changed',

  scanRun: 'scan:run',
  scanProgress: 'scan:progress',
  scanCancel: 'scan:cancel',

  softwarePick: 'software:pick',
  softwareInspect: 'software:inspect',
  softwareAdd: 'software:add',
  softwareScan: 'software:scan',

  filesPreview: 'files:preview',

  applyRun: 'apply:run',

  historyList: 'history:list',
  historyRollback: 'history:rollback',
  historyRemove: 'history:remove',

  backupsList: 'backups:list',
  backupsRemove: 'backups:remove',
  backupsReveal: 'backups:reveal',

  rulesList: 'rules:list',
  rulesAdd: 'rules:add',
  rulesUpdate: 'rules:update',
  rulesRemove: 'rules:remove',
  rulesReset: 'rules:reset',
  rulesValidate: 'rules:validate',
  rulesTest: 'rules:test',

  ignoresList: 'ignores:list',
  ignoresAdd: 'ignores:add',
  ignoresUpdate: 'ignores:update',
  ignoresRemove: 'ignores:remove',
  ignoresReset: 'ignores:reset',

  pickProjectPath: 'dialogs:pick-project-path',
  saveTextFile: 'dialogs:save-text-file',

  systemInfo: 'system:info',
  systemShowProjectFile: 'system:show-project-file'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
