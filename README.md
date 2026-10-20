# 无限书场 | Infinite Reading Gallery

一个为 Obsidian 打造的 EPUB 无限画布书架与双页阅读器。拖动画布浏览书籍，搜索并定位书目，聚焦封面后即可翻开阅读。

## 功能

- 自动发现 vault 中的 EPUB 文件并提取封面
- 在平铺画布上拖动、滚轮平移，支持惯性移动和目录定位
- 将 EPUB 文件拖入书场，自动复制到 vault 的 `书籍/` 文件夹
- 点击封面进入双页 EPUB 阅读器，支持目录、页叠跳转、脚注提示与文本标注
- 保存阅读进度；EPUB 移动后尝试按文件指纹恢复记录
- 启用插件后自动在 Obsidian 左侧 Ribbon 添加“打开无限书场”按钮

## 安装

1. 从 GitHub Releases 下载插件包，解压到 vault 的 `.obsidian/plugins/infinite-reading-gallery/`。
2. 在 Obsidian 设置的“第三方插件”中启用“无限书场”。
3. 点击左侧书本图标，或运行命令“打开无限书场”。

如果你此前分别启用了 `constructivist-dashboard` 和 `constructivist-epub-reader`，请先停用这两个旧插件，再启用本插件。首次启动会尝试迁移旧阅读器的进度和标注。

## 隐私

插件在本地读取 vault 中的 EPUB 文件以显示书名和封面。阅读进度和标注保存在插件自己的 `data.json` 中。把电脑中的 EPUB 拖入书场时，文件会复制到 vault 的 `书籍/` 文件夹。插件代码不发送网络请求。

## 开发

```bash
npm install
npm run build
```

构建会将 `src/main.js`、阅读器模块和 `epubjs` 打包为 Obsidian 可加载的 `main.js`，并合并书场和阅读器样式。插件运行时不需要用户再安装 npm 依赖。

## English

An infinite EPUB gallery and double-page reader for Obsidian. It discovers EPUB files in the vault, extracts covers, supports panning and catalog search, and opens books in an embedded reader with contents navigation, page-stack jumps, footnotes, annotations, and saved progress. Enabling the plugin adds a book icon to Obsidian's left ribbon.
