#!/usr/bin/env node

const AdmZip = require('adm-zip');
const path = require('path')
const fs = require('fs')
const fsPromises = require('fs/promises')
const minimatch = require('minimatch');
const request = require('request')
const shortid = require('shortid');
const ora = require('ora');

const configFilePath = path.resolve(process.cwd(), './.iconfontrc.json')

const getConfig = async () => {
    const configFile = await fsPromises.readFile(
        configFilePath,
        { encoding: 'utf-8' }
    )
    return JSON.parse(configFile)
}

const requestFile = async ({ downloadUrl, dirname, cookie }) => {

    const downloadFileName = `download_${shortid.generate()}.zip`
    const downloadAbsolutePath = path.resolve(process.cwd(), dirname)
    const downloadSavePath = path.resolve(downloadAbsolutePath, downloadFileName)

    const isExist = fs.existsSync(downloadAbsolutePath)
    if (!isExist) fs.mkdirSync(downloadAbsolutePath, { recursive: true })

    return new Promise((resolve, reject) => {
        request
            .get(
                downloadUrl,
                {
                    headers: {
                        cookie,
                        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_12_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/75.0.3770.100 Safari/537.36'
                    }
                })
            .on('complete', () => {
                resolve(downloadSavePath)
            })
            .on('error', (err) => {
                reject(err)
            })
            .pipe(fs.createWriteStream(downloadSavePath))
    })
}

const clearTempFile = (tempFilePath) => {
    return fsPromises.unlink(tempFilePath)
}

const run = async () => {
    let tempFilePath
    const spinner = ora('iconfont-updater: 开始下载字体文件...').start()

    try {
        const config = await getConfig()

        tempFilePath = await requestFile(config)

        const zip = new AdmZip(tempFilePath);
        const zipEntries = zip.getEntries();

        zipEntries.forEach(({ isDirectory, entryName }) => {
            const isInclude = config.includes ? config.includes.some(ele => minimatch(entryName, ele)) : true

            if (!isDirectory && isInclude) {
                zip.extractEntryTo(entryName, config.dirname, false, true);
            }
        })
        spinner.succeed('iconfont-updater: 已更新')
    } catch (err) {
        spinner.fail('iconfont-updater: 更新失败')
        console.log(err)
    } finally {
        await clearTempFile(tempFilePath)
    }
}

run()


