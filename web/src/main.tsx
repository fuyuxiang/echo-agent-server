import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'
import 'antd/dist/reset.css'
import { applyEchoVariables, echoTheme } from './theme'
import './styles.css'

applyEchoVariables()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={echoTheme}>
      <App />
    </ConfigProvider>
  </React.StrictMode>,
)
