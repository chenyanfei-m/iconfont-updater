#!/usr/bin/env node

const program = require('commander');
const ora = require('ora');
const { run, clearSettings } = require('../src');

const spinner = ora();

program.option('--clear', '清除所有设定');

program.parse(process.argv);

if (program.clear) {
  clearSettings();
} else {
  run().catch(err => {
    spinner.clear();
    spinner.fail('发生错误，请重试');
    console.error(err);
  });
}
