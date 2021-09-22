# iconfont-updater

一个用于更新项目内iconfont的库

## 安装

`yarn add iconfont-updater --dev`

或

`npm install iconfont-updater --save-dev`

下同

## 使用

创建一个`.iconfontrc.json`文件到项目根目录中，配置如下：

```
{
    // 保存到项目的哪个文件夹下
    // 默认项目根目录
    "output": "./static/iconfont",

    // glob 匹配
    // 由于下载下来的zip解压是一个文件夹所以加**
    // 有些时候我们只需要某种类型的文件，比如我用symbol只需要js文件
    // 默认所有类型文件
    "includes": ["**/*.js"]
}
```

在项目根目录执行 `yarn iconfont-updater`，之后进入`github`登录和选择`iconfont`项目的流程

更常见的情况是搭配`package.json`中的`scripts`使用：

在`scripts`内添加

```
{
    "update:iconfont": "iconfont-updater"
}
```

然后 `yarn run update:iconfont`

### 清除配置

如需清除保存的配置，请执行 `yarn iconfont-updater --clear`

### 常见的问题

最常见的问题是由于Github超时导致代码抛出错误，对于此情况，请科学切换网络环境
## 感谢

此项目基于[mp-iconfont-cli](https://github.com/deepfunc/mp-iconfont-cli)，在此表示感谢
