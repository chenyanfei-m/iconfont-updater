const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');
const ora = require('ora');
const inquirer = require('inquirer');
const axios = require('axios');
const cookie = require('cookie')
const AdmZip = require('adm-zip')
const minimatch = require('minimatch')
const { get } = require('lodash')
const dayjs = require('dayjs')

const CWD = process.cwd();
const spinner = ora();
const Configstore = require('configstore');
const config = new Configstore(CWD);
const userConfigFilePath = path.resolve(process.cwd(), './.iconfontrc.json')

const GITHUB_ACCOUNT = 'githubAccount';
const GITHUB_PASSWORD = 'githubPassword';
const ICON_PROJECT_ID = 'iconProjectId';

// TODO: 将所有流程接口化
async function run() {
  const userConfig = await getUserConfig();
  spinner.start('正在初始化');
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  spinner.succeed('初始化完毕');
  try {
    await gotoHomepage(page);
    await loginToGithub(page);
    await settingAxios(page);
    await updateProjectId();
    await downloadProjectSource(userConfig);
  } catch (e) {
    spinner.stop();
    throw e;
  } finally {
    await page.close();
    await browser.close();
  }
}

const getUserConfig = async () => {
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

async function getCookies(page) {
  const { cookies } = await page._client.send('Network.getAllCookies')
  const iconfontCookies = cookies.filter(ele => ele.domain.match(/\.iconfont\.cn$/))

  return iconfontCookies
}

async function getSerializedCookies(cookies) {
  const result = cookies.reduce((acc, ele) => {
    return `${acc}${cookie.serialize(ele.name, ele.value)}; `
  }, '')

  return result
}

async function settingAxios(page) {
  spinner.succeed('Github 授权完毕')
  const cookies = await getCookies(page)
  const ctoken = cookies.find(ele => ele.name === 'ctoken').value
  const defaultParams = {
    ctoken,
  }

  const cookie = await getSerializedCookies(cookies)
  const defaultHeaders = {
    cookie,
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_12_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/75.0.3770.100 Safari/537.36'
  }

  axios.defaults.baseURL = 'https://www.iconfont.cn'
  axios.defaults.params = defaultParams
  axios.defaults.headers = defaultHeaders
  axios.interceptors.request.use(function (config) {
    const finalConfig = {
      ...config,
      params: {
        ...config.params,
        t: +new Date()
      }
    }
    return finalConfig;
  }, function (error) {
    return Promise.reject(error);
  });
}

async function getProjects() {
  const projectsPath = '/api/user/myprojects.json'
  const { data: { data: { corpProjects } } } = await axios.get(projectsPath)
  return corpProjects
}

async function getProjectDetail(pid) {
  const projectDetailPath = '/api/project/detail.json'
  const { data: { data: { project } } } = await axios.get(projectDetailPath, {
    params: { pid }
  })
  return project
}

async function downloadZipFile(projectId) {
  const downloadPath = '/api/project/download.zip'
  const { data } = await axios.get(downloadPath, {
    params: { pid: projectId },
    responseType: 'arraybuffer'
  })
  return data
}

async function gotoHomepage(page) {
  spinner.start('访问 iconfont 主页');
  await page.goto('https://www.iconfont.cn/', { waitUntil: 'domcontentloaded' });
  spinner.succeed('iconfont 主页加载完毕');
  await page.evaluate(() => location.href = '/api/login/github')
}

async function loginToGithub(page, isRetry = false) {
  if (isRetry) {
    spinner.fail('登录失败，请重试')
  } else {
    spinner.start('正在加载 GitHub 登录页')
    await page.waitForNavigation({ waitUntil: 'domcontentloaded' });
    spinner.succeed('GitHub 登录页已加载')
  }
  const loginFieldOfGithub = await page.waitForSelector('#login_field');
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
    await page.evaluate(ele => ele.value = '', loginFieldOfGithub)
  }
  await loginFieldOfGithub.type(account);
  const passwordFieldOfGithub = await page.$('#password');

  await passwordFieldOfGithub.type(password);
  const submitOfGithub = await page.$('input[type="submit"]');
  await submitOfGithub.click();

  /**
   * 分为三种情况
   * 1. 登录失败，跳登录页
   * 2. 需要手动授权，跳授权页
   * 3. 登录成功，跳iconfont主页
   */
  spinner.start('加载中，请稍候')
  page.waitForNavigation({ waitUntil: 'domcontentloaded' });

  const result = await Promise.race([
    page.waitForSelector('#login_field'),
    page.waitForSelector('#js-oauth-authorize-btn:enabled'),
    page.waitForFunction(() => location.href.includes('//www.iconfont.cn'))
  ])
  if (get(result, 'constructor.name') === 'ElementHandle') {
    const id = await page.evaluate((ele) => ele.id, result)
    if (id === 'login_field') {
      clearSettings(false)
      await loginToGithub(page, true)
      return
    } else {
      result.click()
      await page.waitForFunction(() => location.href.includes('//www.iconfont.cn'))
    }
  }
}

async function updateProjectId() {
  spinner.start('开始加载项目列表')
  const projects = await getProjects()
  spinner.succeed('项目列表加载完毕');

  const selectedProjectId = config.get(ICON_PROJECT_ID);
  const iconProjectIsExist = projects.some(ele => ele.id === selectedProjectId)

  if (iconProjectIsExist) return

  const message = selectedProjectId && !iconProjectIsExist
    ? '项目不存在，请重新选择 iconfont 项目：'
    : '请选择 iconfont 项目：'

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

async function downloadProjectSource({ output, includes }) {
  const selectedProjectId = config.get(ICON_PROJECT_ID);

  const { update_at, name } = await getProjectDetail(selectedProjectId)
  ora().info(`项目 ${name} 最后更新时间为 ${dayjs(update_at).format('YYYY-MM-DD HH:mm:ss')}`)

  spinner.start('正在下载文件...')

  const finalOutputPath = path.resolve(CWD, output)
  const fileBuffer = await downloadZipFile(selectedProjectId)

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

function clearSettings(showLog = true) {
  config.clear();
  showLog && ora().succeed('配置已清除')
}

module.exports = {
  run,
  clearSettings
};
