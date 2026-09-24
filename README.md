# oh-my-dsh

DSH Web 插件组合：手机界面、登录、受信页面、侧栏和可选的 Codex。

## 安装

先批准，再安装；安装时联网下载并校验四个插件，不在仓库保存插件文件。

```sh
dsh plugin --profile web approve-builds \
  'oh-my-dsh@git+https://github.com/KeqingMoe/oh-my-dsh.git' \
  'node-pty@1.1.0'
dsh plugin --profile web add github:KeqingMoe/oh-my-dsh
dsh plugin --profile web exec node node_modules/oh-my-dsh/scripts/install-plugins.mjs check
```

第一项信任此仓库的安装脚本（含未来提交），第二项只允许该版终端依赖构建。首次预批准的 `not awaiting approval` 提示不影响授权。安装后重启 DSH Web。

只批准单次提交：第一项改为 `oh-my-dsh@https://codeload.github.com/KeqingMoe/oh-my-dsh/tar.gz/<完整SHA>`，安装地址同时改为 `github:KeqingMoe/oh-my-dsh#<完整SHA>`。

<details>
<summary>已经安装过、但脚本被拦？</summary>

批准后仅重试 `add` 不会补跑下载。执行以下命令，成功后再启动 Web：

```sh
dsh plugin --profile web exec node node_modules/oh-my-dsh/scripts/install-plugins.mjs install
```

</details>

## 包含

| 功能 | 插件 |
|---|---|
| 受信页面 | `dsh-trusted-page` |
| 手机界面 | `dsh-mobile-upgrade` |
| Web 登录 | `dsh-web-startup-auth` |
| 手机 Enter 换行 | `@jiesou/dsh-webui-fix-mobile-enter-newline` |
| 文件、Git 与终端侧栏 | `dsh-better-sidebar` |
| 可选 Codex Web | `dsh-codex` |

`dsh-mobile-upgrade` 的许可见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)；本项目采用 [MIT 许可](LICENSE)。
