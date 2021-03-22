#!/usr/bin/env node

const program = require('commander');
const ora = require('ora');
const { IconfontUpdater, clearSettings } = require('../src');

const spinner = ora();

program.option('--clear', '清除保存的设定（账号，密码等）');

program.parse(process.argv);

if (program.clear) {
  clearSettings();
} else {
  new IconfontUpdater().run().catch(err => {
    spinner.clear();
    spinner.fail('发生错误，请重试');
    console.error(err);
  });
}
