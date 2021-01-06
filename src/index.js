const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');
const ora = require('ora');
const inquirer = require('inquirer');
const axios = require('axios');
const cookie = require('cookie')
const AdmZip = require('adm-zip')
const minimatch = require('minimatch')

const CWD = process.cwd();
const spinner = ora();
const Configstore = require('configstore');
const config = new Configstore(CWD);
const userConfigFilePath = path.resolve(process.cwd(), './.iconfontrc.json')

const GITHUB_ACCOUNT = 'githubAccount';
const GITHUB_PASSWORD = 'githubPassword';
const ICON_PROJECT_ID = 'iconProjectId';

// TODO: 将所有流程接口化
async function updateIconfontMain() {
  const userConfig = await getUserConfig();
  spinner.start('正在初始化');
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  spinner.succeed('初始化完毕');
  try {
    await gotoIconfontHome(page);
    await loginOfGithub(page);
    await authOfGithub(page);
    await gotoIconfontMyProjects(page);
    await settingAxios(page);
    await updateSelectedProjectId();
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

async function downloadZipFile(projectId) {
  const downloadPath = '/api/project/download.zip'
  const { data } = await axios.get(downloadPath, {
    params: { pid: projectId },
    responseType: 'arraybuffer'
  })
  return data
}

async function gotoIconfontHome(page) {
  spinner.start('访问 iconfont 主页');
  await page.goto('https://www.iconfont.cn/', { waitUntil: 'networkidle0' });
  const loginEle = await page.$('.signin');
  await loginEle.click();
  const loginGithubEle = await page.waitForSelector(
    'a[href^="/api/login/github"]',
    { visible: true }
  );
  spinner.succeed('iconfont 主页加载完毕');
  await loginGithubEle.click();
}

async function loginOfGithub(page) {
  spinner.start('访问 GitHub 登录页面');
  await page.waitForNavigation({ waitUntil: 'networkidle0' });
  const loginFieldOfGithub = await page.waitForSelector('#login_field');
  spinner.succeed('GitHub 登录页面加载完毕');
  let account = config.get(GITHUB_ACCOUNT);
  let password = config.get(GITHUB_PASSWORD);

  if (account == null) {
    const githubAccountInput = await inquirer.prompt({
      type: 'input',
      name: 'githubAccount',
      message: '请输入 Github 账号名称：'
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

  await loginFieldOfGithub.type(account);
  const passwordFieldOfGithub = await page.$('#password');
  await passwordFieldOfGithub.type(password);
  const submitOfGithub = await page.$('input[type="submit"]');
  await submitOfGithub.click();
}

async function authOfGithub(page) {
  spinner.start('GitHub 正在授权');
  const isNeedAuth = async page => {
    let ret = true;

    await page.waitForNavigation({ waitUntil: 'networkidle0' });
    try {
      await page.waitForSelector('#js-oauth-authorize-btn', { timeout: 3000 });
    } catch {
      ret = false;
    }

    return ret;
  };

  if (await isNeedAuth(page)) {
    const authBtn = await page.waitForSelector(
      '#js-oauth-authorize-btn:enabled'
    );
    await authBtn.click();
  }

  spinner.succeed('GitHub 授权完毕');
}

async function gotoIconfontMyProjects(page) {
  spinner.start('正在加载项目列表');
  await page.waitForSelector('a[href="/manage/index"]', { visible: true });
  await page.goto(
    'https://www.iconfont.cn/manage/index?manage_type=myprojects',
    { waitUntil: 'networkidle0' }
  );
}

async function updateSelectedProjectId() {
  spinner.succeed('项目列表加载完毕');
  const projects = await getProjects()

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
  spinner.start('正在下载文件...')

  const selectedProjectId = config.get(ICON_PROJECT_ID);
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

function clearSettings() {
  config.clear();
  ora().succeed('配置已清除')
}

module.exports = {
  updateIconfontMain,
  clearSettings
};
