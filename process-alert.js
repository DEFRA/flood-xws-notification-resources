const AWS = require('aws-sdk')
const { parse } = require('caplib')
const { Feed } = require('feed')
const s3 = new AWS.S3()
const sns = new AWS.SNS()
const ddb = new AWS.DynamoDB.DocumentClient()
const filesBucketName = process.env.FILES_BUCKET_NAME
// const filesBucketUrl = process.env.FILES_BUCKET_URL
const alertsTableName = process.env.ALERTS_TABLE_NAME

async function getAlertFile (key) {
  const result = await s3.getObject({
    Key: key,
    Bucket: filesBucketName
  }).promise()

  console.log(result)

  return result
}

function getAlertMetadata (file) {
  const xml = file.Body.toString()
  console.log('CAPXML', xml)

  const alert = parse(xml)
  console.log(alert)

  const { identifier, sender, source } = alert
  const info = alert.infos[0]
  const { headline, description } = info
  const area = info.areas[0]
  const { areaDesc: areaName } = area
  const { value: areaCode } = area.geocodes[0]

  console.log(identifier, headline, description, sender, source, areaName, areaCode)

  return {
    identifier,
    headline,
    description,
    sender,
    source,
    areaName,
    areaCode
  }
}

async function saveAlert ({ identifier, headline, sender, source, areaName, areaCode }) {
  const item = {
    area_code: `ALERT#${areaCode}`,
    area_name: areaName,
    identifier,
    sender,
    source,
    headline,
    created_at: Date.now()
  }

  const result = await ddb.put({
    TableName: alertsTableName,
    Item: item
  }).promise()

  console.log(result)

  return result
}

async function getRss () {
  const params = {
    TableName: alertsTableName
  }

  // Get all alerts
  const result = await ddb.scan(params).promise()
  const alerts = result.Items

  console.log(alerts.length)

  // Get rss feed
  const feed = getRssFeed(alerts)

  const rss = addStylesheet('./rss-style.xsl', feed.rss2())

  console.log(rss)

  return rss
}

async function publishAlertsRss () {
  const rss = await getRss()

  const params = {
    Bucket: filesBucketName,
    Key: 'alerts.xml',
    Body: rss,
    ContentType: 'text/xml'
  }

  const result = await s3.putObject(params).promise()

  console.log(result)
}

async function publishAlert ({ identifier, areaCode, headline, description }) {
  const message = { identifier, area_code: areaCode, headline, description }

  const result = await sns.publish({
    Message: JSON.stringify(message),
    MessageAttributes: {
      area_code: { DataType: 'String', StringValue: areaCode }
    },
    TopicArn: process.env.ALERT_PUBLISHED_TOPIC_ARN
  }).promise()

  console.log('SNS publish result', result)

  return result
}

function getRssFeed (alerts) {
  // Todo: pull titles, author etc. from service/publisher/source/sender
  const feed = new Feed({
    id: 'http://example.com/',
    title: 'Latest alerts from {TODO}',
    description: 'This is my personal feed!',
    generator: 'xws',
    link: 'http://example.com/',
    updated: new Date(),
    image: 'xws.png',
    favicon: './meta/favicon.ico',
    feedLinks: {
      json: 'https://example.com/json',
      atom: 'https://example.com/atom'
    },
    author: {
      name: 'John Doe',
      email: 'johndoe@example.com',
      link: 'https://example.com/johndoe'
    }
  })

  alerts.forEach(alert => {
    feed.addItem({
      id: alert.identifier,
      title: alert.headline,
      link: `/alerts/${alert.identifier}.xml`,
      date: new Date(alert.created_at)
    })
  })

  return feed
}

function addStylesheet (href, xml) {
  const declaration = '<?xml version="1.0" encoding="utf-8"?>\n'
  const decExists = xml.includes(declaration)
  const insertIdx = decExists ? declaration.length : 0
  const instruction = `<?xml-stylesheet type="text/xsl" href="${href}"?>\n`

  return xml.substring(0, insertIdx) + instruction + xml.substring(insertIdx)
}

async function handler (event) {
  console.log(event, event.Records[0].s3)

  // Extract the key from the s3 event data
  const { Records: records } = event
  const record = records[0]
  console.log(record)

  const { s3: data } = record
  console.log(data)

  const key = data.object.key
  console.log('S3 file key', key)

  await processAlert(key)
}

async function processAlert (key) {
  // Get file from s3
  const file = await getAlertFile(key)

  // Parse alert XML and extract data
  const metadata = getAlertMetadata(file)

  // Save alert to db
  await saveAlert(metadata)

  // Publish the RSS file
  await publishAlertsRss()

  // Publish to SNS
  await publishAlert(metadata)
}

module.exports = { handler }
