# Mac 桌面构建

Fork `hs-codeflow/codeflow` 后，在独立构建分支运行 **Desktop macOS DMG and installation**。流水线分别使用 Apple 芯片和 Intel Mac，构建包含 Electron、Client、Web 的 DMG，挂载并复制安装 `.app`，验证桌面窗口、本地工作区创建、退出和第二次启动后的持久化。

安装包 artifact 包含 DMG、SHA256SUMS 和 build.json；验收 artifact 包含 verification.json 和两次启动截图。使用 ad-hoc 签名，不包含 Developer ID、公证或官方更新发布。

Fork 默认不会自动同步上游。通过 GitHub 的 **Sync fork → Update branch** 更新 Fork 的 main；有本地构建改动时，保留独立分支，基于更新后的 main 重新应用并验证。需要自动同步时应另行配置定时同步工作流；本流程只手动打包，不修改同步策略。
