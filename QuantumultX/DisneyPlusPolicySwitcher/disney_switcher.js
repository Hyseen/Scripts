const STATUS_COMING = 2 // 即将登陆
const STATUS_AVAILABLE = 1 // 支持解锁
const STATUS_NOT_AVAILABLE = 0 // 不支持解锁
const STATUS_TIMEOUT = -1 // 检测超时
const STATUS_ERROR = -2 // 检测异常

const $ = new Env('Disney+ 策略切换')
let disneyPolicyName = $.getval('Helge_0x00.Disney_Policy') || 'Disney+'
let debug = $.getval('Helge_0x00.Disney_Debug') === 'true'
let recheck = $.getval('Helge_0x00.Disney_Recheck') === 'true'
let t = parseInt($.getval('Helge_0x00.Disney_Timeout')) || 8000
let sortByTime = $.getval('Helge_0x00.Disney_Sort_By_Time') === 'true'
let concurrency = parseInt($.getval('Helge_0x00.Disney_Concurrency')) || 10

;(async () => {
  if (!$.isQuanX()) {
    throw '该脚本仅支持在 Quantumult X 中运行'
  }
  let policies = await sendMessage({ action: 'get_customized_policy' })
  if (!isValidPolicy(policies[disneyPolicyName])) {
    disneyPolicyName = lookupTargetPolicy(policies)
    console.log(`更新策略组名称 ➟ ${disneyPolicyName}`)
    $.setval(disneyPolicyName, 'Helge_0x00.Disney_Policy')
  }

  let curPolicyPath = await getSelectedPolicy(disneyPolicyName)
  let selected = curPolicyPath[1]
  let actualNode = curPolicyPath[curPolicyPath.length - 1]
  if (debug) {
    console.log(`当前选择的策略：${curPolicyPath.join(' ➤ ')}`)
  }

  let { region, status } = await test(actualNode)
  if (status === STATUS_AVAILABLE) {
    let flag = getCountryFlagEmoji(region) ?? ''
    let regionName = REGIONS?.[region.toUpperCase()]?.chinese ?? ''
    $.msg($.name, `${actualNode}`, `当前节点支持 Disney+ ➟ ${flag} ${regionName}`)
    return
  }

  let cachePolicies = []
  try {
    cachePolicies = JSON.parse($.getval('Helge_0x00.Disney_Available_Policies') ?? '[]')
  } catch (error) {
    console.log('getCachePolicies error: ' + error)
    cachePolicies = []
  }

  let paths = lookupPath(policies, disneyPolicyName)
  let nodes = new Set(paths.map(path => path[path.length - 1]).filter(item => !['proxy', 'direct', 'reject'].includes(item)))

  // 检测一遍缓存的可用节点是否还在当前策略中
  cachePolicies = cachePolicies.filter(item => nodes.has(item.policy) && item.policy !== selected)

  // 切换前重新检测是否可用
  if (recheck) {
    cachePolicies = await testPolicies(cachePolicies.map(item => item.policy))
    if (sortByTime) {
      cachePolicies = cachePolicies.sort((m, n) => m.time - n.time)
    }
  }

  $.setval(JSON.stringify(cachePolicies), 'Helge_0x00.Disney_Available_Policies')
  if (cachePolicies.length <= 0) {
    throw '没有可用策略，请先运行 「Disney+ 解锁检测」脚本'
  }

  let { policy: newPolicy, region: newRegion } = cachePolicies[0]
  // 找到切换路径，并按照路径长度排序，取路径长度最短的
  let switchPath = paths.filter(path => path[path.length - 1] === newPolicy).sort((m, n) => m.length - n.length)[0]
  let switchDict = {}
  for (let i = 0; i < switchPath.length - 1; i++) {
    switchDict[switchPath[i]] = switchPath[i + 1]
  }

  await setPolicyState(switchDict)
  let flag = getCountryFlagEmoji(newRegion) ?? ''
  let regionName = REGIONS?.[newRegion.toUpperCase()]?.chinese ?? ''
  console.log(`\n切换策略：${curPolicyPath.join(' ➤ ')} ➟ ${switchPath.join(' ➤ ')}`)
  $.msg($.name, `${curPolicyPath[curPolicyPath.length - 1]} ➟ ${switchPath[switchPath.length - 1]}`, `该节点支持 Disney+ ➟ ${flag} ${regionName}`)
})()
  .catch(error => {
    console.log(error)
    if (typeof error === 'string') {
      $.msg($.name, '', `${error} ⚠️`)
    }
  })
  .finally(() => {
    $.done()
  })

async function getSelectedPolicy(policyName) {
  let message = {
    action: 'get_policy_state',
    content: policyName,
  }

  let ret = await sendMessage(message)
  return ret?.[policyName]
}

async function setPolicyState(policyDict) {
  let message = {
    action: 'set_policy_state',
    content: policyDict,
  }
  try {
    await sendMessage(message)
  } catch (e) {
    if (debug) {
      console.log(`策略切换失败：${e}`)
    }
    throw '策略切换失败，请重试'
  }
}

function getHomePage(policyName) {
  return new Promise((resolve, reject) => {
    let request = {
      url: 'https://www.disneyplus.com/',
      opts: {
        redirection: false,
        policy: policyName,
      },
      headers: {
        'Accept-Language': 'en',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.71 Safari/537.36',
      },
    }
    $task.fetch(request).then(
      response => {
        let {
          statusCode,
          headers: { Location: location },
          body,
        } = response

        if (statusCode === 302) {
          if (debug) {
            console.log(`${policyName} getHomePage, 302, Location: ${location}`)
          }
          // 不可用
          if (location.indexOf('Sorry, Disney+ is not available in your region.') !== -1) {
            if (debug) {
              console.log(policyName + ': Not Available')
            }
            reject('Not Available')
            return
          }

          // 即将登陆
          if (location.indexOf('preview') !== -1) {
            if (debug) {
              console.log(policyName + ': Preview')
            }
            resolve({ status: STATUS_COMING })
            return
          }

          // 非国际版 Disney+
          reject('Not Available')
          return
        }

        if (statusCode === 200) {
          let match = body.match(/^Region: ([A-Za-z]{2})$/m)
          if (!match) {
            reject('Not Available')
            return
          }

          let region = match[1]
          resolve({ region, status: STATUS_AVAILABLE })
          return
        }

        reject('Not Available')
      },
      reason => {
        if (debug) {
          console.log(`${policyName} getHomePage Error: ${reason.error}`)
        }
        reject('Error')
      }
    )
  })
}

function testPublicGraphqlAPI(policyName, accessToken) {
  return new Promise((resolve, reject) => {
    let request = {
      url: 'https://disney.api.edge.bamgrid.com/v1/public/graphql',
      method: 'POST',
      headers: {
        'Accept-Language': 'en',
        Authorization: accessToken,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.71 Safari/537.36',
      },
      opts: {
        redirection: false,
        policy: policyName,
      },
      body: JSON.stringify({
        query:
          'query($preferredLanguages: [String!]!, $version: String) {globalization(version: $version) { uiLanguage(preferredLanguages: $preferredLanguages) }}',
        variables: { version: '1.5.0', preferredLanguages: ['en'] },
      }),
    }

    $task.fetch(request).then(
      response => {
        let { statusCode } = response
        resolve(statusCode === 200)
      },
      reason => {
        if (debug) {
          console.log(`${policyName} queryLanguage Error: ${reason.error}`)
        }
        reject('Error')
      }
    )
  })
}

function getLocationInfo(policyName) {
  return new Promise((resolve, reject) => {
    let request = {
      url: 'https://disney.api.edge.bamgrid.com/graph/v1/device/graphql',
      method: 'POST',
      headers: {
        'Accept-Language': 'en',
        Authorization: 'ZGlzbmV5JmJyb3dzZXImMS4wLjA.Cu56AgSfBTDag5NiRA81oLHkDZfu5L3CKadnefEAY84',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.71 Safari/537.36',
      },
      opts: {
        redirection: false,
        policy: policyName,
      },
      body: JSON.stringify({
        query: 'mutation registerDevice($input: RegisterDeviceInput!) { registerDevice(registerDevice: $input) { grant { grantType assertion } } }',
        variables: {
          input: {
            applicationRuntime: 'chrome',
            attributes: {
              browserName: 'chrome',
              browserVersion: '94.0.4606',
              manufacturer: 'apple',
              model: null,
              operatingSystem: 'macintosh',
              operatingSystemVersion: '10.15.7',
              osDeviceIds: [],
            },
            deviceFamily: 'browser',
            deviceLanguage: 'en',
            deviceProfile: 'macosx',
          },
        },
      }),
    }

    $task.fetch(request).then(
      response => {
        let { statusCode, body } = response
        if (statusCode !== 200) {
          if (debug) {
            console.log(`${policyName} getLocationInfo: ${body}`)
          }
          reject('Not Available')
          return
        }

        let {
          token: { accessToken },
          session: {
            inSupportedLocation,
            location: { countryCode },
          },
        } = JSON.parse(body)?.extensions?.sdk
        resolve({ inSupportedLocation, countryCode, accessToken })
      },
      reason => {
        if (debug) {
          console.log(`${policyName} getLocationInfo Error: ${reason.error}`)
        }
        reject('Error')
      }
    )
  })
}

async function test(policyName) {
  console.log(`开始检测 ${policyName}`)
  let startTime = new Date().getTime()
  try {
    let { countryCode, inSupportedLocation, accessToken } = await Promise.race([getLocationInfo(policyName), timeout(t)])
    if (debug) {
      console.log(`${policyName} getLocationInfo: countryCode=${countryCode}, inSupportedLocation=${inSupportedLocation}`)
    }

    // 支持 Disney+
    if (inSupportedLocation === true || inSupportedLocation === 'true') {
      let support = await Promise.race([testPublicGraphqlAPI(policyName, accessToken), timeout(t)])
      if (!support) {
        return { status: STATUS_NOT_AVAILABLE, policy: policyName, time: new Date().getTime() - startTime }
      }
      return {
        region: countryCode,
        status: STATUS_AVAILABLE,
        policy: policyName,
        time: new Date().getTime() - startTime,
      }
    }

    let { status } = await Promise.race([getHomePage(policyName), timeout(t)])
    if (debug) {
      console.log(`${policyName} getHomePage: status=${status}`)
    }

    // 即将登陆
    if (status === STATUS_COMING) {
      return { region: countryCode, status: STATUS_COMING, policy: policyName, time: new Date().getTime() - startTime }
    }

    // 不支持 Disney+
    return { status: STATUS_NOT_AVAILABLE, policy: policyName, time: new Date().getTime() - startTime }
  } catch (error) {
    if (debug) {
      console.log(`${policyName}: ${error}`)
    }

    // 不支持 Disney+
    if (error === 'Not Available') {
      return { status: STATUS_NOT_AVAILABLE, policy: policyName, time: new Date().getTime() - startTime }
    }

    // 检测超时
    if (error === 'Timeout') {
      return { status: STATUS_TIMEOUT, policy: policyName, time: new Date().getTime() - startTime }
    }

    return { status: STATUS_ERROR, policy: policyName, time: new Date().getTime() - startTime }
  }
}

async function testPolicies(policies = []) {
  let availablePolicies = []
  let echo = results => {
    console.log(`\n策略组检测结果：`)
    for (let { policy, status, region, time } of results) {
      switch (status) {
        case STATUS_COMING: {
          let flag = getCountryFlagEmoji(region) ?? ''
          let regionName = REGIONS?.[region.toUpperCase()]?.chinese ?? ''
          console.log(`${policy}: Disney+ 即将登陆 ➟ ${flag}${regionName}`)
          break
        }
        case STATUS_AVAILABLE: {
          let flag = getCountryFlagEmoji(region) ?? ''
          let regionName = REGIONS?.[region.toUpperCase()]?.chinese ?? ''
          console.log(`${policy}: 支持 Disney+ ➟ ${flag}${regionName}`)
          availablePolicies.push({ policy, region, time })
          break
        }
        case STATUS_NOT_AVAILABLE:
          console.log(`${policy}: 不支持 Disney+`)
          break
        case STATUS_TIMEOUT:
          console.log(`${policy}: 检测超时`)
          break
        default:
          console.log(`${policy}: 检测异常`)
      }
    }
  }

  await Promise.map(policies, subPolicy => test(subPolicy), { concurrency })
    .then(echo)
    .catch(error => console.log(error))

  return availablePolicies
}

function timeout(delay = 5000) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      reject('Timeout')
    }, delay)
  })
}

function getCountryFlagEmoji(countryCode) {
  if (countryCode.toUpperCase() === 'TW') {
    countryCode = 'CN'
  }
  const codePoints = countryCode
    .toUpperCase()
    .split('')
    .map(char => 127397 + char.charCodeAt())
  return String.fromCodePoint(...codePoints)
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    $configuration.sendMessage(message).then(
      response => {
        if (response.error) {
          if (debug) {
            console.log(`${message?.action} error: ${response.error}`)
          }
          reject(response.error)
          return
        }

        resolve(response.ret)
      },
      error => {
        // Normally will never happen.
        reject(error)
      }
    )
  })
}

function lookupPath(policies = {}, policyGroupName = '', curPath = [], paths = []) {
  let targetPolicy = policies[policyGroupName]

  if (targetPolicy === undefined || targetPolicy?.type === undefined || !Array.isArray(targetPolicy?.candidates)) {
    return paths
  }

  curPath.push(policyGroupName)

  if (targetPolicy?.type !== 'static') {
    paths.push([...curPath])
    return paths
  }

  for (const policy of targetPolicy?.candidates) {
    if (policies[policy] === undefined) {
      paths.push([...curPath, policy])
      continue
    }

    // 成环了
    if (curPath.includes(policy)) {
      paths.push([...curPath, policy, '⚠️', 'direct'])
      continue
    }

    lookupPath(policies, policy, [...curPath], paths)
  }
  return paths
}

function lookupTargetPolicy(policies = {}) {
  let policyNames = Object.entries(policies)
    .filter(([key, val]) => key.search(/Disney\+|Disney Plus|迪士尼/gi) !== -1)
    .map(([key, val]) => key)
  if (policyNames.length === 1) {
    return policyNames[0]
  } else if (policyNames.length <= 0) {
    throw '没有找到 Disney+ 策略组，请在 BoxJS 中填写正确的策略组名称'
  } else {
    throw `找到多个 Disney+ 策略组，请在 BoxJS 中填写正确的策略组名称`
  }
}

function isValidPolicy(policy) {
  return policy !== undefined && policy?.type !== undefined && Array.isArray(policy?.candidates)
}

// prettier-ignore
Array.prototype.remove=function(e){let t=this.indexOf(e);-1!==t&&this.splice(t,1)}

// prettier-ignore
Promise.map=function(t,e,{concurrency:u}){const i=new class{constructor(t){this.limit=t,this.count=0,this.queue=[]}enqueue(t){return new Promise((e,u)=>{this.queue.push({fn:t,resolve:e,reject:u})})}dequeue(){if(this.count<this.limit&&this.queue.length){const{fn:t,resolve:e,reject:u}=this.queue.shift();this.run(t).then(e).catch(u)}}async run(t){this.count++;const e=await t();return this.count--,this.dequeue(),e}build(t){return this.count<this.limit?this.run(t):this.enqueue(t)}}(u);return Promise.all(t.map((...t)=>i.build(()=>e(...t))))}

// prettier-ignore
const REGIONS={AF:{chinese:'阿富汗',english:'Afghanistan'},AL:{chinese:'阿尔巴尼亚',english:'Albania'},DZ:{chinese:'阿尔及利亚',english:'Algeria'},AO:{chinese:'安哥拉',english:'Angola'},AR:{chinese:'阿根廷',english:'Argentina'},AM:{chinese:'亚美尼亚',english:'Armenia'},AU:{chinese:'澳大利亚',english:'Australia'},AT:{chinese:'奥地利',english:'Austria'},AZ:{chinese:'阿塞拜疆',english:'Azerbaijan'},BH:{chinese:'巴林',english:'Bahrain'},BD:{chinese:'孟加拉国',english:'Bangladesh'},BY:{chinese:'白俄罗斯',english:'Belarus'},BE:{chinese:'比利时',english:'Belgium'},BZ:{chinese:'伯利兹',english:'Belize'},BJ:{chinese:'贝宁',english:'Benin'},BT:{chinese:'不丹',english:'Bhutan'},BO:{chinese:'玻利维亚',english:'Bolivia'},BA:{chinese:'波黑',english:'Bosnia and Herzegovina'},BW:{chinese:'博茨瓦纳',english:'Botswana'},BR:{chinese:'巴西',english:'Brazil'},VG:{chinese:'英属维京群岛',english:'British Virgin Islands'},BN:{chinese:'文莱',english:'Brunei'},BG:{chinese:'保加利亚',english:'Bulgaria'},BF:{chinese:'布基纳法索',english:'Burkina-faso'},BI:{chinese:'布隆迪',english:'Burundi'},KH:{chinese:'柬埔寨',english:'Cambodia'},CM:{chinese:'喀麦隆',english:'Cameroon'},CA:{chinese:'加拿大',english:'Canada'},CV:{chinese:'佛得角',english:'Cape Verde'},KY:{chinese:'开曼群岛',english:'Cayman Islands'},CF:{chinese:'中非',english:'Central African Republic'},TD:{chinese:'乍得',english:'Chad'},CL:{chinese:'智利',english:'Chile'},CN:{chinese:'中国',english:'China'},CO:{chinese:'哥伦比亚',english:'Colombia'},KM:{chinese:'科摩罗',english:'Comoros'},CG:{chinese:'刚果(布)',english:'Congo - Brazzaville'},CD:{chinese:'刚果(金)',english:'Congo - Kinshasa'},CR:{chinese:'哥斯达黎加',english:'Costa Rica'},HR:{chinese:'克罗地亚',english:'Croatia'},CY:{chinese:'塞浦路斯',english:'Cyprus'},CZ:{chinese:'捷克',english:'Czech Republic'},DK:{chinese:'丹麦',english:'Denmark'},DJ:{chinese:'吉布提',english:'Djibouti'},DO:{chinese:'多米尼加',english:'Dominican Republic'},EC:{chinese:'厄瓜多尔',english:'Ecuador'},EG:{chinese:'埃及',english:'Egypt'},SV:{chinese:'萨尔瓦多',english:'EI Salvador'},GQ:{chinese:'赤道几内亚',english:'Equatorial Guinea'},ER:{chinese:'厄立特里亚',english:'Eritrea'},EE:{chinese:'爱沙尼亚',english:'Estonia'},ET:{chinese:'埃塞俄比亚',english:'Ethiopia'},FJ:{chinese:'斐济',english:'Fiji'},FI:{chinese:'芬兰',english:'Finland'},FR:{chinese:'法国',english:'France'},GA:{chinese:'加蓬',english:'Gabon'},GM:{chinese:'冈比亚',english:'Gambia'},GE:{chinese:'格鲁吉亚',english:'Georgia'},DE:{chinese:'德国',english:'Germany'},GH:{chinese:'加纳',english:'Ghana'},GR:{chinese:'希腊',english:'Greece'},GL:{chinese:'格陵兰',english:'Greenland'},GT:{chinese:'危地马拉',english:'Guatemala'},GN:{chinese:'几内亚',english:'Guinea'},GY:{chinese:'圭亚那',english:'Guyana'},HT:{chinese:'海地',english:'Haiti'},HN:{chinese:'洪都拉斯',english:'Honduras'},HK:{chinese:'香港',english:'Hong Kong'},HU:{chinese:'匈牙利',english:'Hungary'},IS:{chinese:'冰岛',english:'Iceland'},IN:{chinese:'印度',english:'India'},ID:{chinese:'印度尼西亚',english:'Indonesia'},IR:{chinese:'伊朗',english:'Iran'},IQ:{chinese:'伊拉克',english:'Iraq'},IE:{chinese:'爱尔兰',english:'Ireland'},IM:{chinese:'马恩岛',english:'Isle of Man'},IL:{chinese:'以色列',english:'Israel'},IT:{chinese:'意大利',english:'Italy'},CI:{chinese:'科特迪瓦',english:'Ivory Coast'},JM:{chinese:'牙买加',english:'Jamaica'},JP:{chinese:'日本',english:'Japan'},JO:{chinese:'约旦',english:'Jordan'},KZ:{chinese:'哈萨克斯坦',english:'Kazakstan'},KE:{chinese:'肯尼亚',english:'Kenya'},KR:{chinese:'韩国',english:'Korea'},KW:{chinese:'科威特',english:'Kuwait'},KG:{chinese:'吉尔吉斯斯坦',english:'Kyrgyzstan'},LA:{chinese:'老挝',english:'Laos'},LV:{chinese:'拉脱维亚',english:'Latvia'},LB:{chinese:'黎巴嫩',english:'Lebanon'},LS:{chinese:'莱索托',english:'Lesotho'},LR:{chinese:'利比里亚',english:'Liberia'},LY:{chinese:'利比亚',english:'Libya'},LT:{chinese:'立陶宛',english:'Lithuania'},LU:{chinese:'卢森堡',english:'Luxembourg'},MO:{chinese:'澳门',english:'Macao'},MK:{chinese:'马其顿',english:'Macedonia'},MG:{chinese:'马达加斯加',english:'Madagascar'},MW:{chinese:'马拉维',english:'Malawi'},MY:{chinese:'马来西亚',english:'Malaysia'},MV:{chinese:'马尔代夫',english:'Maldives'},ML:{chinese:'马里',english:'Mali'},MT:{chinese:'马耳他',english:'Malta'},MR:{chinese:'毛利塔尼亚',english:'Mauritania'},MU:{chinese:'毛里求斯',english:'Mauritius'},MX:{chinese:'墨西哥',english:'Mexico'},MD:{chinese:'摩尔多瓦',english:'Moldova'},MC:{chinese:'摩纳哥',english:'Monaco'},MN:{chinese:'蒙古',english:'Mongolia'},ME:{chinese:'黑山',english:'Montenegro'},MA:{chinese:'摩洛哥',english:'Morocco'},MZ:{chinese:'莫桑比克',english:'Mozambique'},MM:{chinese:'缅甸',english:'Myanmar'},NA:{chinese:'纳米比亚',english:'Namibia'},NP:{chinese:'尼泊尔',english:'Nepal'},NL:{chinese:'荷兰',english:'Netherlands'},NZ:{chinese:'新西兰',english:'New Zealand'},NI:{chinese:'尼加拉瓜',english:'Nicaragua'},NE:{chinese:'尼日尔',english:'Niger'},NG:{chinese:'尼日利亚',english:'Nigeria'},KP:{chinese:'朝鲜',english:'North Korea'},NO:{chinese:'挪威',english:'Norway'},OM:{chinese:'阿曼',english:'Oman'},PK:{chinese:'巴基斯坦',english:'Pakistan'},PA:{chinese:'巴拿马',english:'Panama'},PY:{chinese:'巴拉圭',english:'Paraguay'},PE:{chinese:'秘鲁',english:'Peru'},PH:{chinese:'菲律宾',english:'Philippines'},PL:{chinese:'波兰',english:'Poland'},PT:{chinese:'葡萄牙',english:'Portugal'},PR:{chinese:'波多黎各',english:'Puerto Rico'},QA:{chinese:'卡塔尔',english:'Qatar'},RE:{chinese:'留尼旺',english:'Reunion'},RO:{chinese:'罗马尼亚',english:'Romania'},RU:{chinese:'俄罗斯',english:'Russia'},RW:{chinese:'卢旺达',english:'Rwanda'},SM:{chinese:'圣马力诺',english:'San Marino'},SA:{chinese:'沙特阿拉伯',english:'Saudi Arabia'},SN:{chinese:'塞内加尔',english:'Senegal'},RS:{chinese:'塞尔维亚',english:'Serbia'},SL:{chinese:'塞拉利昂',english:'Sierra Leone'},SG:{chinese:'新加坡',english:'Singapore'},SK:{chinese:'斯洛伐克',english:'Slovakia'},SI:{chinese:'斯洛文尼亚',english:'Slovenia'},SO:{chinese:'索马里',english:'Somalia'},ZA:{chinese:'南非',english:'South Africa'},ES:{chinese:'西班牙',english:'Spain'},LK:{chinese:'斯里兰卡',english:'Sri Lanka'},SD:{chinese:'苏丹',english:'Sudan'},SR:{chinese:'苏里南',english:'Suriname'},SZ:{chinese:'斯威士兰',english:'Swaziland'},SE:{chinese:'瑞典',english:'Sweden'},CH:{chinese:'瑞士',english:'Switzerland'},SY:{chinese:'叙利亚',english:'Syria'},TW:{chinese:'台湾',english:'Taiwan'},TJ:{chinese:'塔吉克斯坦',english:'Tajikstan'},TZ:{chinese:'坦桑尼亚',english:'Tanzania'},TH:{chinese:'泰国',english:'Thailand'},TG:{chinese:'多哥',english:'Togo'},TO:{chinese:'汤加',english:'Tonga'},TT:{chinese:'特立尼达和多巴哥',english:'Trinidad and Tobago'},TN:{chinese:'突尼斯',english:'Tunisia'},TR:{chinese:'土耳其',english:'Turkey'},TM:{chinese:'土库曼斯坦',english:'Turkmenistan'},VI:{chinese:'美属维尔京群岛',english:'U.S. Virgin Islands'},UG:{chinese:'乌干达',english:'Uganda'},UA:{chinese:'乌克兰',english:'Ukraine'},AE:{chinese:'阿联酋',english:'United Arab Emirates'},GB:{chinese:'英国',english:'United Kiongdom'},US:{chinese:'美国',english:'USA'},UY:{chinese:'乌拉圭',english:'Uruguay'},UZ:{chinese:'乌兹别克斯坦',english:'Uzbekistan'},VA:{chinese:'梵蒂冈',english:'Vatican City'},VE:{chinese:'委内瑞拉',english:'Venezuela'},VN:{chinese:'越南',english:'Vietnam'},YE:{chinese:'也门',english:'Yemen'},YU:{chinese:'南斯拉夫',english:'Yugoslavia'},ZR:{chinese:'扎伊尔',english:'Zaire'},ZM:{chinese:'赞比亚',english:'Zambia'},ZW:{chinese:'津巴布韦',english:'Zimbabwe'}}

// prettier-ignore
function Env(t,e){class s{constructor(t){this.env=t}send(t,e="GET"){t="string"==typeof t?{url:t}:t;let s=this.get;return"POST"===e&&(s=this.post),new Promise((e,i)=>{s.call(this,t,(t,s,r)=>{t?i(t):e(s)})})}get(t){return this.send.call(this.env,t)}post(t){return this.send.call(this.env,t,"POST")}}return new class{constructor(t,e){this.name=t,this.http=new s(this),this.data=null,this.dataFile="box.dat",this.logs=[],this.isMute=!1,this.isNeedRewrite=!1,this.logSeparator="\n",this.encoding="utf-8",this.startTime=(new Date).getTime(),Object.assign(this,e),this.log("",`\ud83d\udd14${this.name}, \u5f00\u59cb!`)}isNode(){return"undefined"!=typeof module&&!!module.exports}isQuanX(){return"undefined"!=typeof $task}isSurge(){return"undefined"!=typeof $httpClient&&"undefined"==typeof $loon}isLoon(){return"undefined"!=typeof $loon}isShadowrocket(){return"undefined"!=typeof $rocket}toObj(t,e=null){try{return JSON.parse(t)}catch{return e}}toStr(t,e=null){try{return JSON.stringify(t)}catch{return e}}getjson(t,e){let s=e;const i=this.getdata(t);if(i)try{s=JSON.parse(this.getdata(t))}catch{}return s}setjson(t,e){try{return this.setdata(JSON.stringify(t),e)}catch{return!1}}getScript(t){return new Promise(e=>{this.get({url:t},(t,s,i)=>e(i))})}runScript(t,e){return new Promise(s=>{let i=this.getdata("@chavy_boxjs_userCfgs.httpapi");i=i?i.replace(/\n/g,"").trim():i;let r=this.getdata("@chavy_boxjs_userCfgs.httpapi_timeout");r=r?1*r:20,r=e&&e.timeout?e.timeout:r;const[o,h]=i.split("@"),n={url:`http://${h}/v1/scripting/evaluate`,body:{script_text:t,mock_type:"cron",timeout:r},headers:{"X-Key":o,Accept:"*/*"}};this.post(n,(t,e,i)=>s(i))}).catch(t=>this.logErr(t))}loaddata(){if(!this.isNode())return{};{this.fs=this.fs?this.fs:require("fs"),this.path=this.path?this.path:require("path");const t=this.path.resolve(this.dataFile),e=this.path.resolve(process.cwd(),this.dataFile),s=this.fs.existsSync(t),i=!s&&this.fs.existsSync(e);if(!s&&!i)return{};{const i=s?t:e;try{return JSON.parse(this.fs.readFileSync(i))}catch(t){return{}}}}}writedata(){if(this.isNode()){this.fs=this.fs?this.fs:require("fs"),this.path=this.path?this.path:require("path");const t=this.path.resolve(this.dataFile),e=this.path.resolve(process.cwd(),this.dataFile),s=this.fs.existsSync(t),i=!s&&this.fs.existsSync(e),r=JSON.stringify(this.data);s?this.fs.writeFileSync(t,r):i?this.fs.writeFileSync(e,r):this.fs.writeFileSync(t,r)}}lodash_get(t,e,s){const i=e.replace(/\[(\d+)\]/g,".$1").split(".");let r=t;for(const t of i)if(r=Object(r)[t],void 0===r)return s;return r}lodash_set(t,e,s){return Object(t)!==t?t:(Array.isArray(e)||(e=e.toString().match(/[^.[\]]+/g)||[]),e.slice(0,-1).reduce((t,s,i)=>Object(t[s])===t[s]?t[s]:t[s]=Math.abs(e[i+1])>>0==+e[i+1]?[]:{},t)[e[e.length-1]]=s,t)}getdata(t){let e=this.getval(t);if(/^@/.test(t)){const[,s,i]=/^@(.*?)\.(.*?)$/.exec(t),r=s?this.getval(s):"";if(r)try{const t=JSON.parse(r);e=t?this.lodash_get(t,i,""):e}catch(t){e=""}}return e}setdata(t,e){let s=!1;if(/^@/.test(e)){const[,i,r]=/^@(.*?)\.(.*?)$/.exec(e),o=this.getval(i),h=i?"null"===o?null:o||"{}":"{}";try{const e=JSON.parse(h);this.lodash_set(e,r,t),s=this.setval(JSON.stringify(e),i)}catch(e){const o={};this.lodash_set(o,r,t),s=this.setval(JSON.stringify(o),i)}}else s=this.setval(t,e);return s}getval(t){return this.isSurge()||this.isLoon()?$persistentStore.read(t):this.isQuanX()?$prefs.valueForKey(t):this.isNode()?(this.data=this.loaddata(),this.data[t]):this.data&&this.data[t]||null}setval(t,e){return this.isSurge()||this.isLoon()?$persistentStore.write(t,e):this.isQuanX()?$prefs.setValueForKey(t,e):this.isNode()?(this.data=this.loaddata(),this.data[e]=t,this.writedata(),!0):this.data&&this.data[e]||null}initGotEnv(t){this.got=this.got?this.got:require("got"),this.cktough=this.cktough?this.cktough:require("tough-cookie"),this.ckjar=this.ckjar?this.ckjar:new this.cktough.CookieJar,t&&(t.headers=t.headers?t.headers:{},void 0===t.headers.Cookie&&void 0===t.cookieJar&&(t.cookieJar=this.ckjar))}get(t,e=(()=>{})){if(t.headers&&(delete t.headers["Content-Type"],delete t.headers["Content-Length"]),this.isSurge()||this.isLoon())this.isSurge()&&this.isNeedRewrite&&(t.headers=t.headers||{},Object.assign(t.headers,{"X-Surge-Skip-Scripting":!1})),$httpClient.get(t,(t,s,i)=>{!t&&s&&(s.body=i,s.statusCode=s.status),e(t,s,i)});else if(this.isQuanX())this.isNeedRewrite&&(t.opts=t.opts||{},Object.assign(t.opts,{hints:!1})),$task.fetch(t).then(t=>{const{statusCode:s,statusCode:i,headers:r,body:o}=t;e(null,{status:s,statusCode:i,headers:r,body:o},o)},t=>e(t));else if(this.isNode()){let s=require("iconv-lite");this.initGotEnv(t),this.got(t).on("redirect",(t,e)=>{try{if(t.headers["set-cookie"]){const s=t.headers["set-cookie"].map(this.cktough.Cookie.parse).toString();s&&this.ckjar.setCookieSync(s,null),e.cookieJar=this.ckjar}}catch(t){this.logErr(t)}}).then(t=>{const{statusCode:i,statusCode:r,headers:o,rawBody:h}=t;e(null,{status:i,statusCode:r,headers:o,rawBody:h},s.decode(h,this.encoding))},t=>{const{message:i,response:r}=t;e(i,r,r&&s.decode(r.rawBody,this.encoding))})}}post(t,e=(()=>{})){const s=t.method?t.method.toLocaleLowerCase():"post";if(t.body&&t.headers&&!t.headers["Content-Type"]&&(t.headers["Content-Type"]="application/x-www-form-urlencoded"),t.headers&&delete t.headers["Content-Length"],this.isSurge()||this.isLoon())this.isSurge()&&this.isNeedRewrite&&(t.headers=t.headers||{},Object.assign(t.headers,{"X-Surge-Skip-Scripting":!1})),$httpClient[s](t,(t,s,i)=>{!t&&s&&(s.body=i,s.statusCode=s.status),e(t,s,i)});else if(this.isQuanX())t.method=s,this.isNeedRewrite&&(t.opts=t.opts||{},Object.assign(t.opts,{hints:!1})),$task.fetch(t).then(t=>{const{statusCode:s,statusCode:i,headers:r,body:o}=t;e(null,{status:s,statusCode:i,headers:r,body:o},o)},t=>e(t));else if(this.isNode()){let i=require("iconv-lite");this.initGotEnv(t);const{url:r,...o}=t;this.got[s](r,o).then(t=>{const{statusCode:s,statusCode:r,headers:o,rawBody:h}=t;e(null,{status:s,statusCode:r,headers:o,rawBody:h},i.decode(h,this.encoding))},t=>{const{message:s,response:r}=t;e(s,r,r&&i.decode(r.rawBody,this.encoding))})}}time(t,e=null){const s=e?new Date(e):new Date;let i={"M+":s.getMonth()+1,"d+":s.getDate(),"H+":s.getHours(),"m+":s.getMinutes(),"s+":s.getSeconds(),"q+":Math.floor((s.getMonth()+3)/3),S:s.getMilliseconds()};/(y+)/.test(t)&&(t=t.replace(RegExp.$1,(s.getFullYear()+"").substr(4-RegExp.$1.length)));for(let e in i)new RegExp("("+e+")").test(t)&&(t=t.replace(RegExp.$1,1==RegExp.$1.length?i[e]:("00"+i[e]).substr((""+i[e]).length)));return t}msg(e=t,s="",i="",r){const o=t=>{if(!t)return t;if("string"==typeof t)return this.isLoon()?t:this.isQuanX()?{"open-url":t}:this.isSurge()?{url:t}:void 0;if("object"==typeof t){if(this.isLoon()){let e=t.openUrl||t.url||t["open-url"],s=t.mediaUrl||t["media-url"];return{openUrl:e,mediaUrl:s}}if(this.isQuanX()){let e=t["open-url"]||t.url||t.openUrl,s=t["media-url"]||t.mediaUrl;return{"open-url":e,"media-url":s}}if(this.isSurge()){let e=t.url||t.openUrl||t["open-url"];return{url:e}}}};if(this.isMute||(this.isSurge()||this.isLoon()?$notification.post(e,s,i,o(r)):this.isQuanX()&&$notify(e,s,i,o(r))),!this.isMuteLog){let t=["","==============\ud83d\udce3\u7cfb\u7edf\u901a\u77e5\ud83d\udce3=============="];t.push(e),s&&t.push(s),i&&t.push(i),console.log(t.join("\n")),this.logs=this.logs.concat(t)}}log(...t){t.length>0&&(this.logs=[...this.logs,...t]),console.log(t.join(this.logSeparator))}logErr(t,e){const s=!this.isSurge()&&!this.isQuanX()&&!this.isLoon();s?this.log("",`\u2757\ufe0f${this.name}, \u9519\u8bef!`,t.stack):this.log("",`\u2757\ufe0f${this.name}, \u9519\u8bef!`,t)}wait(t){return new Promise(e=>setTimeout(e,t))}done(t={}){const e=(new Date).getTime(),s=(e-this.startTime)/1e3;this.log("",`\ud83d\udd14${this.name}, \u7ed3\u675f! \ud83d\udd5b ${s} \u79d2`),this.log(),(this.isSurge()||this.isQuanX()||this.isLoon())&&$done(t)}}(t,e)}
