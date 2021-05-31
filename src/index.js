const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');
const ora = require('ora');
const inquirer = require('inquirer');
const AdmZip = require('adm-zip')
const minimatch = require('minimatch')
const _ = require('lodash')
const dayjs = require('dayjs')

const CWD = process.cwd();
const spinner = ora();
const Configstore = require('configstore');
const config = new Configstore(CWD);
const userConfigFilePath = path.resolve(process.cwd(), './.iconfontrc.json')

const GITHUB_ACCOUNT = 'githubAccount';
const GITHUB_PASSWORD = 'githubPassword';
const ICON_PROJECT_ID = 'iconProjectId';

class IconfontUpdater {
  page

  // TODO: 将所有流程接口化
  async run() {
    const userConfig = await this.getUserConfig();
    spinner.start('正在初始化');
    const browser = await puppeteer.launch({
      // headless: false
    });
    this.page = await browser.newPage();
    spinner.succeed('初始化完毕');
    try {
      await this.gotoHomepage();
      await this.loginToGithub();
      await this.updateProjectId();
      await this.downloadProjectSource(userConfig);
    } catch (e) {
      spinner.stop();
      throw e;
    } finally {
      await this.page.close();
      await browser.close();
    }
  }

  async get(path, params = {}, formatType = 'json') {
    const isArrayBufferOrBlob = ['arrayBuffer', 'blob'].includes(formatType)

    const result = await this.page.evaluate(async ({ path, params, formatType, isArrayBufferOrBlob }) => {
      const urlObj = new URL(path, location.origin)
      const defaultParams = {
        t: +new Date()
      }
      const finalParams = { ...defaultParams, ...params }
      Object.entries(finalParams).forEach(([key, value]) => {
        urlObj.searchParams.append(key, value)
      })
      const url = urlObj.toString()
      const res = await fetch(url);
      if (!formatType) return
      const result = await res[formatType]();
      // 文件转string再在外面转回文件
      if (isArrayBufferOrBlob) {
        return await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.readAsBinaryString(result);
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject('Error occurred while reading binary string');
        })
      }
      return result
    }, { path, params, formatType, isArrayBufferOrBlob });

    if (isArrayBufferOrBlob) {
      return Buffer.from(result, 'binary');
    }

    return result
  }

  async getUserConfig() {
    let userConfig
    try {
      userConfig = JSON.parse(fs.readFileSync(
        userConfigFilePath,
        { encoding: 'utf-8' }
      ))
    } catch (err) {
      ora().warn('解析 .iconfontrc.json 失败，将使用默认配置')
      userConfig = {}
    }
    const defaultConfig = {
      output: './',
      includes: ['**/*'],
    }
    const finalConfig = {
      ...defaultConfig,
      ...userConfig,
    }

    return finalConfig
  }

  async getProjects() {
    const projectsPath = '/api/user/myprojects.json'
    const { data: { corpProjects } } = await this.get(projectsPath)
    return corpProjects
  }

  async getProjectDetail(pid) {
    const projectDetailPath = '/api/project/detail.json'
    const { data: { project } } = await this.get(projectDetailPath, {
      pid
    })
    return project
  }

  async downloadZipFile(projectId) {
    const downloadPath = '/api/project/download.zip'
    const data = await this.get(downloadPath, { pid: projectId }, 'blob')
    return data
  }

  async gotoHomepage() {
    spinner.start('访问 Iconfont 主页');
    await this.page.goto('https://www.iconfont.cn/', { waitUntil: 'domcontentloaded' });
    spinner.succeed('Iconfont 主页加载完毕');
    await this.page.evaluate(() => location.href = '/api/login/github')
  }

  async waitForNavigationToHome() {
    return await this.page.waitForFunction(() => location.hostname === 'www.iconfont.cn' && location.pathname === '/')
  }

  async loginToGithub(isRetry = false) {
    if (isRetry) {
      spinner.fail('登录失败，请重试')
    } else {
      spinner.start('正在加载 GitHub 登录页')
      await this.page.waitForNavigation({ waitUntil: 'domcontentloaded' });
      spinner.succeed('GitHub 登录页加载完毕')
    }
    const loginFieldOfGithub = await this.page.waitForSelector('#login_field');
    let account = config.get(GITHUB_ACCOUNT);
    let password = config.get(GITHUB_PASSWORD);

    if (typeof account !== 'string') {
      const githubAccountInput = await inquirer.prompt({
        type: 'input',
        name: 'githubAccount',
        message: '请输入 GitHub 用户名或邮箱地址：',
      });
      const githubPasswordInput = await inquirer.prompt({
        type: 'password',
        name: 'githubPassword',
        message: `请输入 ${githubAccountInput.githubAccount} 的登录密码：`
      });
      account = githubAccountInput.githubAccount;
      password = githubPasswordInput.githubPassword;
      config.set(GITHUB_ACCOUNT, account);
      config.set(GITHUB_PASSWORD, password);
    }

    if (isRetry) {
      await this.page.evaluate(ele => ele.value = '', loginFieldOfGithub)
    }
    await loginFieldOfGithub.type(account);
    const passwordFieldOfGithub = await this.page.$('#password');

    await passwordFieldOfGithub.type(password);
    const submitOfGithub = await this.page.$('input[type="submit"]');
    await submitOfGithub.click();

    /**
     * 分为三种情况
     * 1. 登录失败，跳登录页
     * 2. 需要手动授权，跳授权页
     * 3. 登录成功，跳iconfont主页
     */
    spinner.start('加载中，请稍候')
    this.page.waitForNavigation({ waitUntil: 'domcontentloaded' });

    const result = await Promise.race([
      this.page.waitForSelector('#login_field'),
      this.page.waitForSelector('#js-oauth-authorize-btn:enabled'),
      this.waitForNavigationToHome(),
    ])
    if (_.get(result, 'constructor.name') === 'ElementHandle') {
      const id = await this.page.evaluate((ele) => ele.id, result)
      if (id === 'login_field') {
        clearSettings(false)
        await this.loginToGithub(true)
        return
      } else {
        result.click()
        await this.waitForNavigationToHome()
      }
    }
  }

  async updateProjectId() {
    spinner.start('开始加载项目列表')
    const projects = await this.getProjects()
    spinner.succeed('项目列表加载完毕');

    const selectedProjectId = config.get(ICON_PROJECT_ID);
    const iconProjectIsExist = projects.some(ele => ele.id === selectedProjectId)

    if (iconProjectIsExist) return

    const message = selectedProjectId && !iconProjectIsExist
      ? '项目不存在，请重新选择 Iconfont 项目：'
      : '请选择 Iconfont 项目：'

    const iconProjectInput = await inquirer.prompt({
      type: 'list',
      name: 'projectId',
      message,
      choices: projects.map(ele => ({
        name: ele.name,
        value: ele.id,
        short: `已选择 ${ele.name}`
      }))
    });

    config.set(ICON_PROJECT_ID, iconProjectInput.projectId);
  }

  async downloadProjectSource({ output, includes }) {
    const selectedProjectId = config.get(ICON_PROJECT_ID);
    const { updated_at, name } = await this.getProjectDetail(selectedProjectId)
    ora().info(`项目 ${name} 最后更新时间为 ${dayjs(updated_at).format('YYYY-MM-DD HH:mm:ss')}`)

    spinner.start('正在下载文件...')

    const finalOutputPath = path.resolve(CWD, output)
    const fileBuffer = await this.downloadZipFile(selectedProjectId)

    const zip = new AdmZip(fileBuffer);
    const zipEntries = zip.getEntries();
    zipEntries.forEach(({ isDirectory, entryName }) => {
      const isInclude = includes ? includes.some(ele => minimatch(entryName, ele)) : true
      if (!isDirectory && isInclude) {
        zip.extractEntryTo(entryName, finalOutputPath, false, true);
      }
    })

    spinner.succeed('下载完成')
  }

}

function clearSettings(showLog = true) {
  config.clear();
  showLog && ora().succeed('已清除保存的设定')
}

module.exports = {
  IconfontUpdater,
  clearSettings
};
