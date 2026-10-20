let running;
exports.activate = async context => {
  const { activate } = await import('./runtime.mjs');
  running = await activate(context, require('vscode'));
};
exports.deactivate = async () => { await running?.dispose(); };
