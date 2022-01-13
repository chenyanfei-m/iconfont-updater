const path = require('path')
const fs = require('fs')
const puppeteer = require('puppeteer-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
const ora = require('ora')
const inquirer = require('inquirer')
const AdmZip = require('adm-zip')
const minimatch = require('minimatch')
const _ = require('lodash')
const dayjs = require('dayjs')
const { to } = require('await-to-js')
const axios = require('axios')

const CWD = process.cwd()
const spinner = ora()
const Configstore = require('configstore')
const config = new Configstore(CWD)
const userConfigFilePath = path.resolve(process.cwd(), './.iconfontrc.json')

const ICON_COOKIE = 'iconCoookie'
const ICON_PROJECT_ID = 'iconProjectId'

const ORIGIN = 'https://www.iconfont.cn'

puppeteer.use(StealthPlugin())
class IconfontUpdater {
  browser
  page
  cookie

  // TODO: 将所有流程接口化
  async run() {
    try{

      const userConfig = await this.getUserConfig()
      this.cookie = config.get(ICON_COOKIE)

      // 如果err代表没有登录
      const [isNotLoggedIn] = await to(this.updateProjectId())

      if (isNotLoggedIn) {
        await this.initBrowserAndPage()
        await this.waitLogin()
        await this.updateProjectId()
      }

      await this.downloadProjectSource(userConfig)
    } finally {
      spinner.clear();
    }
  }

  async get(url, options = {}) {
    _.set(options, 'baseURL', ORIGIN)
    _.set(options, 'headers.cookie', this.cookie)

    return new Promise((resolve, reject) => {
      axios
        .get(url, options)
        .then((res) => {
          if (res?.data?.code === 500) reject(res.data || res)
          resolve(res.data)
        })
        .catch((err) => {
          resolve(err)
        })
    })
  }

  async getUserConfig() {
    let userConfig
    try {
      userConfig = JSON.parse(
        fs.readFileSync(userConfigFilePath, { encoding: 'utf-8' })
      )
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
    const {
      data: { corpProjects },
    } = await this.get(projectsPath)
    return corpProjects
  }

  async getProjectDetail(pid) {
    const projectDetailPath = '/api/project/detail.json'
    const {
      data: { project },
    } = await this.get(`${projectDetailPath}?pid=${pid}`)
    return project
  }

  async downloadZipFile(projectId) {
    return this.get(`/api/project/download.zip?pid=${projectId}`, {
      responseType: 'arraybuffer',
    })
  }

  async gotoLoginPage() {
    await this.page.goto(ORIGIN, {
      waitUntil: 'domcontentloaded',
    })
    await this.page.evaluate(() => (location.href = '/login'))
  }

  async initBrowserAndPage() {
    spinner.start('正在初始化')
    this.browser = await puppeteer.launch({
      headless: false,
      timeout: 0,
      defaultViewport: null,
    })
    console.log(this.browser.cur)
    this.page = await this.browser.newPage()
    spinner.succeed('初始化完毕')
  }

  async waitLogin() {
    spinner.start('等待登录完成（可以使用手机号或Github登录')
    await this.gotoLoginPage()
    const cookie = await new Promise((resolve, reject) => {
      this.page.on('response', async (data) => {
        const githubLoginCbUrl = `${ORIGIN}/api/login/github/callback`
        const githubSucceed = data._status === 302 && data?._url.startsWith(githubLoginCbUrl)

        const iconfontLoginUrl = 'https://www.iconfont.cn/api/account/login.json'
        const iconfontSucceed = data?._url === iconfontLoginUrl

        // 监听官方登录和github登录
        if (iconfontSucceed || githubSucceed) {
          // 停止page load，防止重定向丢失alert的执行上下文
          await this.page._client.send('Page.stopLoading')
          // 只取cookie真正的值，其他的去掉
          resolve(data._headers['set-cookie'].match(/EGG_SESS_ICONFONT=.+?;/)?.[0])
        }
      })
      // TODO: 关闭浏览器自动退出程序
      this.browser.on('disconnected', (rst) => reject(rst))
      this.page.on('close', (rst) => reject(rst))
    })
    await this.page.evaluate(() =>
      window.alert('登录成功，即将关闭浏览器，请返回终端继续操作')
    )
    await this.browser.close()

    // 更新this cookie
    this.cookie = cookie
    config.set(ICON_COOKIE, cookie)

    spinner.succeed('登录完成')
  }

  async updateProjectId() {
    spinner.start('开始加载项目列表')
    const projects = await this.getProjects()
    spinner.succeed('项目列表加载完毕')

    const selectedProjectId = config.get(ICON_PROJECT_ID)
    const iconProjectIsExist = projects.some(
      (ele) => ele.id === selectedProjectId
    )

    if (iconProjectIsExist) return

    const message =
      selectedProjectId && !iconProjectIsExist
        ? '项目不存在，请重新选择 Iconfont 项目：'
        : '请选择 Iconfont 项目：'

    const iconProjectInput = await inquirer.prompt({
      type: 'list',
      name: 'projectId',
      message,
      choices: projects.map((ele) => ({
        name: ele.name,
        value: ele.id,
        short: `已选择 ${ele.name}`,
      })),
    })

    config.set(ICON_PROJECT_ID, iconProjectInput.projectId)
  }

  async downloadProjectSource({ output, includes }) {
    const selectedProjectId = config.get(ICON_PROJECT_ID)
    const { updated_at, name } = await this.getProjectDetail(selectedProjectId)
    ora().info(
      `项目 ${name} 最后更新时间为 ${dayjs(updated_at).format(
        'YYYY-MM-DD HH:mm:ss'
      )}`
    )

    spinner.start('正在下载文件...')

    const finalOutputPath = path.resolve(CWD, output)
    const fileBuffer = Buffer.from(
      await this.downloadZipFile(selectedProjectId)
    )

    const zip = new AdmZip(fileBuffer)
    const zipEntries = zip.getEntries()
    zipEntries.forEach(({ isDirectory, entryName }) => {
      const isInclude = includes
        ? includes.some((ele) => minimatch(entryName, ele))
        : true
      if (!isDirectory && isInclude) {
        zip.extractEntryTo(entryName, finalOutputPath, false, true)
      }
    })

    spinner.succeed('下载完成')
  }
}

function clearSettings(showLog = true) {
  config.clear()
  showLog && ora().succeed('已清除保存的设定')
}

module.exports = {
  IconfontUpdater,
  clearSettings,
}
