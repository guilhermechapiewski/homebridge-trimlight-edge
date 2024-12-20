(Original documentation)[https://39877180.fs1.hubspotusercontent-na1.net/hubfs/39877180/Manuals/Trimlight_Edge_API_Documentation%208192022.pdf]

# Trimlight V2 OAuth API Documentation

## 1. Auth

Each request needs to carry the following request headers:

You need to follow the steps below to calculate the **accessToken**:

1.  Concatenate strings: `"Trimlight|<S-ClientId>|<S-Timestamp>"`
2.  Compute the HMAC-SHA256 of the string concatenated in step 1. The secret key for HMAC-SHA256 is clientSecret.
3.  The value of the accessToken is the **base64 encoding** of the computed HMAC-SHA256 value.

Please contact our business to obtain \[clientId] and \[clientSecret].

**Example**:

*   clientId: tester
*   clientSecret: test\_secret
*   timestamp: 1713166849256

The concatenated string is: `"Trimlight|tester|1713166849256"`, and the base64 of HMAC-SHA256 value is: `"z02N77XySuOwv5OSUe0vrPwprRITb656xKPulS9ooXI="`, and that is the access token.

## 2. Base URL

```
"authorization": "<accessToken>"
"S-ClientId": "<clientId>"
"S-Timestamp": 111 // Timestamp (milliseconds relative to 1970.1.1) 
```

`POST https://trimlight.ledhue.com/trimlight`

## 3. Get device list

**Request params**:

`GET /v1/oauth/resources/devices`

```
{
"page": 1 // 10 devices on one page // If the value is 0 or null, it will return to the list of all devices
}
```

**Response result**:

```
{
"code": 0,
"desc": "success",
"payload": {
"total": 2,
"current": 1,
"data": [
{ "deviceId": "xxxxxxxxxxx1",
"name": "xxxx1",
"switchState": 0,
"connectivity": 1,
"state": 0,
"fwVersionName": "1.1.1"
},
{
"deviceId": "xxxxxxxxxxx2",
"name": "xxxx2",
"switchState": 0,
"connectivity": 1,
"state": 0,
"fwVersionName": "1.1.1"
}
]
}
}
```

**Response result code details**:

| Field | Description                      | Type    |
| :---- | :------------------------------- | :------ |
| code  | Result code. \               | Integer |
| desc  | Result description.             | String  |
| payload | Result payload.                  | Object  |

**Page fields details**:

| Field   | Description                      | Type    |
| :----- | :------------------------------- | :------ |
| total  | Number of all devices.           | Integer |
| page   | The page number of the current data. | Integer |
| data   | device list.                    | List   |

**Device fields details**:

| Field          | Description                                                                                                                                                                          | Type    |
| :------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------ |
| deviceId      | Unique ID of the device.                                                                                                                                                                 | String  |
| name          | Device name.                                                                                                                                                                              | String  |
| switchState   | Device switch state. 0 : light off. 1 : manual mode. 2 : timer mode.                                                                                                                           | Integer |
| connectivity | Device connectivity state. 0 : offline. 1 : online.                                                                                                                                   | Integer |
| state         | Device state. 0 : normal. 1 : upgrading.                                                                                                                                                  | Integer |
| fwVersionName | Device firmware version name.                                                                                                                                                           | String  |

## 4. Get device detail data

**Request params**:

`POST /v1/oauth/resources/device/get`

**Current date details**:

| Field   | Description                                                                               | Type    |
| :----- | :---------------------------------------------------------------------------------------- | :------ |
| year    | Current date year. Years relative to 2000.                                                 | Integer |
| month   | Current date month. Range: \.                                                     | Integer |
| day     | Current date day. Range: \.                                                      | Integer |
| weekday | Current day of week. SUNDAY = 1, MONDAY = 2, TUESDAY = 3, WEDNESDAY = 4, THURSDAY = 5, FRIDAY = 6, SATURDAY = 7 | Integer |
| hours   | Current date year. Range: \.                                                      | Integer |
| minutes | Current date year. Range: \.                                                      | Integer |
| seconds | Current date year. Range: \.                                                      | Integer |

**Response result**:

```
{
"deviceId": "<device-id>", "currentDate": { "year": 21, // 2021 "month": 1, "day": 1, "weekday": 1, "hours": 1, "minutes": 1, "seconds": 1 }
}
```

```
{
"code": 0,
"desc": "success",
"payload": {
"name": "xxxx2",
"switchState": 0,
"connectivity": 1,
"state": 0,
"colorOrder": 0,
"ic": 0,
"ports": [
{ "id": 0,
"start": 1,
"end": 1024
},
{
"id": 1,
"start": 1,
"end": 1024
},
{
"id": 2,
"start": 1,
"end": 1024
},
{
"id": 3,
"start": 1,
"end": 1024
}
],
"fwVersionName": "1.1.1",
"effects": [
{ "id": 0,
"name": "New Year",
"category": 0,
"mode": 0,
"speed": 100,
"brightness": 100,
"pixelLen": 30,
"reverse": false
},
{
"id": 1,
"name": "xxxxxxxx2",
"category": 1,
"mode": 0,
"speed": 100,
"brightness": 100,
"pixels": [
{ "index": 0,
"count": 5,
"color": 16711680,
"disable": false
},
{
"index": 1,
"count": 10,
"color": 65280,
"disable": false
},
{
"index": 2,
"count": 10,
"color": 255,
"disable": false
}
]
}
],
"combinedEffect": {
"effectIds":,
"interval": 5
},
"daily": [
{ "id": 0,
"enable": true,
"effectId": 0,
"repetition": 1,
"startTime": {
"hours": 10,
"minutes": 1
},
"endTime": {
"hours": 11,
"minutes": 1
}
},
{
"id": 1,
"enable": true,
"effectId": 1,
"repetition": 1,
"startTime": {
"hours": 10,
"minutes": 1
},
"endTime": {
"hours": 11,
"minutes": 1
}
}
],
"calendar": [
{ "id": 0,
"effectId": 1,
"startDate": {
"month": 12,
"day": 31
},
"endDate": {
"month": 1,
"day": 1
},
"startTime": {
"hours": 10,
"minutes": 1
},
"endTime": {
"hours": 11,
"minutes": 1
}
},
{
"id": 1,
"effectId": 2,
"startDate": {
"month": 12,
"day": 31
},
"endDate": {
"month": 1,
"day": 1
},
"startTime": {
"hours": 10,
"minutes": 1
},
"endTime": {
"hours": 11,
"minutes": 1
}
}
],
"currentEffect": { "category": 1, "mode": 1, "speed": 174, "brightness": 204, "pixelLen": 37, "reverse": false } }
}
```

**Device fields details**:

| Field          | Description                                                                                                                                                                  | Type    |
| :------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------ |
| name          | Device name.                                                                                                                                                                      | String  |
| switchState   | Device switch state. 0 : light off. 1 : manual mode. 2 : timer mode.                                                                                                           | Integer |
| connectivity | Device connectivity state. 0 : offline. 1 : online.                                                                                                                            | Integer |
| state         | Device state. 0 : normal. 1 : upgrading.                                                                                                                                      | Integer |
| colorOrder    | Color order. \.                                                                                                                                                           | Integer |
| ic            | IC. \                                                                                                                                                                     | Integer |
| ports         | The pixel setting for each port. id: Port ID, range from 0 to 3, correspond to port1, port2, port3, port4. start: The start pixel of the port. range: \ end: The end pixel of the port. range: \. "start" should not greater than "end". | List   |
| fwVersionName | Device firmware version name.                                                                                                                                               | String  |
| effects        | All the effects stored in the device.                                                                                                                                        | List   |
| combinedEffect | Combine effect.                                                                                                                                                                 | Object  |
| daily          | Daily schedules. Each device has two daily schedules.                                                                                                                         | List   |
| calendar       | Calendar schedules.                                                                                                                                                           | List   |
| currentEffect  | Device current running effect. (If the device's switch state is timer mode, although the light is off at this time, it will return the last running effect data.) Note: The effect ID will be -1, when the controller is running a preview effect (not yet saved). | Object  |

#### 4.1 Device fields details

#### 4.2 Effect fields details

| Field       | Description                                                                                                                                                         | Type    |
| :---------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :------ |
| id          | Effect ID. ID of the saved effect. Note that it may be -1 in currentEffect , when the controller is running a preview effect (not yet saved).                          | Integer |
| category   | Effect category. 0 : build-in effect. 1 : custom effect.                                                                                                           | Integer |
| mode        | Effect mode. Build-in effect (category value is 0) mode range: \. \ Custom effect (category value is 1) mode range: \. \                     | Integer |
| speed       | Effect speed. Speed range: \.                                                                                                                            | Integer |
| brightness  | Effect brightness. Brightness range: \.                                                                                                                     | Integer |
| pixelLen    | Effect pixel length. (Only required for build-in effects) Pixel length range: \.                                                                              | Integer |
| reverse     | Reverse effect. (Only required for build-in effects)                                                                                                                | Boolean |
| pixels      | Custom effect pixels. (Only required for build-in effects)                                                                                                         | List   |

#### 4.3 Pixel fields details

| Field  | Description              | Type    |
| :----- | :----------------------- | :------ |
| index  | Custom effect pixel index. | Integer |
| count  | Custom effect pixel count. | Integer |
| color  | Custom effect pixel color. | Integer |
| disable | Disable pixel.          | Boolean |

#### 4.4 Combined effect fields details

| Field      | Description                                                                                                   | Type  |
| :--------- | :------------------------------------------------------------------------------------------------------------ | :---- |
| effectIds | A list of each effects' ID in the combined effect.                                                                 | List  |
| interval   | The interval between switching to the next effect. (Unit: minute.)                                                   | Integer |

#### 4.5 Daily schedule fields details

| Field      | Description                                                                                                            | Type   |
| :--------- | :--------------------------------------------------------------------------------------------------------------------- | :----- |
| id         | Daily schedule ID. 0: daily schedule 1. 1: daily schedule 2.                                                                | List   |
| enable     | Enable daily schedule.                                                                                                       | Boolean |
| effectId   | Effect ID in the daily schedule.                                                                                           | Integer |
| repetition | The repetition of daily schedule.                                                                                       | Integer |
| startTime  | The start time of daily schedule. See schedule time fields details.                                                     | Object  |
| endTime    | The end time of daily schedule. See schedule time fields details.                                                     | Object  |

#### 4.6 Schedule Time fields details

| Field   | Description                                       | Type    |
| :----- | :------------------------------------------------ | :------ |
| hours   | Schedule hours, range from \.              | Integer |
| minutes | Schedule minutes, range from \.             | Integer |

#### 4.7 Calendar schedule fields details

| Field      | Description                                                                                                           | Type   |
| :--------- | :-------------------------------------------------------------------------------------------------------------------- | :----- |
| id         | Calendar schedule ID. Schedule ID range: \. Up to 60 calendar schedules can be saved.                             | List   |
| effectId   | Effect ID in the calendar schedule.                                                                                    | Integer |
| startDate  | The start date of calendar schedule. See schedule date fields details.                                                  | Object  |
| endDate    | The end date of calendar schedule. See schedule date fields details.                                                  | Object  |
| startTime  | The start time in each day of calendar schedule. See schedule time fields details.                                    | Object  |
| endTime    | The end time in each day of calendar schedule. See schedule time fields details.                                    | Object  |

#### 4.8 Schedule date fields details

| Field  | Description                                | Type    |
| :----- | :----------------------------------------- | :------ |
| month  | Schedule month, range from \.       | Integer |
| day    | Schedule day, range from \.        | Integer |

#### 4.9 Effect fields details

| Field       | Description                                                                                                                                               | Type    |
| :---------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------- | :------ |
| category   | Effect category. 0 : build-in effect. 1 : custom effect.                                                                                                   | Integer |
| mode        | Effect mode. Build-in effect (category value is 0) mode range: \. \ Custom effect (category value is 1) mode range: \. \             | Integer |
| speed       | Effect speed. Speed range: \.                                                                                                                    | Integer |
| brightness  | Effect brightness. Brightness range: \.                                                                                                           | Integer |
| pixelLen    | Effect pixel length. (Only available for build-in effects) Pixel length range: \.                                                                  | Integer |
| reverse     | Reverse effect. (Only available for build-in effects)                                                                                                    | Boolean |
| pixels      | Custom effect pixels. (Only available for build-in effects)                                                                                               | List   |

## 5. Set device switch state

**Request params**:

`POST /v1/oauth/resources/device/update`

```
{
"deviceId": "<device-id>", "payload": { "switchState": 0 }
}
```

**Response result**:

```
{
"code": 0, "desc": "success"
}
```

## 6. Set device name

**Request params**:

`POST /v1/oauth/resources/device/update`

```
{
"deviceId": "<device-id>", "payload": { "name": "xxx" }
}
```

**Response result**:

```
{
"code": 0, "desc": "success"
}
```

## 7. Set device color order

**Request params**:

`POST /v1/oauth/resources/device/update`

```
{
"deviceId": "<device-id>", "payload": { "colorOrder": 0 }
}
```

**Response result**:

```
{
"code": 0, "desc": "success"
}
```

## 8. Set device IC

**Request params**:

`POST /v1/oauth/resources/device/update`

```
{
"deviceId": "<device-id>", "payload": { "ic": 0 }
}
```

**Response result**:

```
{
"code": 0, "desc": "success"
}
```

## 9. Set device port

**Request params**:

`POST /v1/oauth/resources/device/update`

```
{
"deviceId": "<device-id>", "payload": { "ports": [ { "id": 0, // "start": 1, "end": 1024 } ] }
}
```

**Response result**:

```
{
"code": 0, "desc": "success"
}
```

## 10. Preview build-in effect

**Effect fields details**:

| Field       | Description                                                                                                                                | Type    |
| :---------- | :----------------------------------------------------------------------------------------------------------------------------------------- | :------ |
| category   | Effect category. 0 : build-in effect. 1 : custom effect. Here the value is 0.                                                              | Integer |
| mode        | Build-in effect mode. Build-in effect mode range: \. \                                                                       | Integer |
| speed       | Effect speed. Speed range: \.                                                                                                     | Integer |
| brightness  | Effect brightness. Brightness range: \.                                                                                                | Integer |
| pixelLen    | Effect pixel length. Pixel length range: \.                                                                                          | Integer |
| reverse     | Reverse effect.                                                                                                                           | Boolean |

**Request params**:

`POST /v1/oauth/resources/device/effect/preview`

```
{
"deviceId": "<device-id>", "payload": { "category": 0, "mode": 0, "speed": 100, "brightness": 100, "pixelLen": 10, "reverse": false }
}
```

**Response result**:

```
{
"code": 0, "desc": "success"
}
```

**Example**

Build-in effect

```
{
"deviceId": "<device-id>", "payload": { "category": 1, "mode": 1, "speed": 100, "brightness": 100, "pixelLen": 10, "reverse": false }
}
```

## 11. Preview custom effect

**Request params**:

`POST /v1/oauth/resources/device/effect/preview`

```
{
"deviceId": "<device-id>", "payload": { "category": 1, "mode": 0, "speed": 100, "brightness": 100, "pixels": [ { "index": 0, "count": 5, "color": 16711680, // (0xFF0000) "disable": false }, { "index": 1, "count": 10,
"color": 16711680, "disable": false } ] }
}
```

**Effect fields details**:

| Field       | Description                                                                                                                                     | Type    |
| :---------- | :---------------------------------------------------------------------------------------------------------------------------------------------- | :------ |
| category   | Effect category. 0 : build-in effect. 1 : custom effect. Here the value is 1.                                                                  | Integer |
| mode        | Effect mode. Custom effect mode range: \. \                                                                                        | Integer |
| speed       | Effect speed. Speed range: \.                                                                                                           | Integer |
| brightness  | Effect brightness. Brightness range: \.                                                                                                  | Integer |
| pixels      | Custom effect pixels.                                                                                                                          | List   |

**Pixel fields details**:

| Field  | Description                               | Type    |
| :----- | :---------------------------------------- | :------ |
| index  | Custom pixel index. Index range: \.   | Integer |
| count  | Custom pixel count. Pixel count range: \. | Integer |
| color  | Custom pixel color decimal value. eg: 0xFF0000 =\> 16711680. | Integer |
| disable | Custom pixel disable.                       | Boolean |

**Response result**:

```
{
"code": 0, "desc": "success"
}
```

**Example**

Custom effect

```
{
"deviceId": "<device-id>", "payload": {
"category": 2, "mode": 1, "speed": 100, "brightness": 100, "pixels": [ { "index": 0, "count": 10, "color": 255, "disable": false }, { "index": 1, "count": 2, "color": 0, "disable": true }, { "index": 2, "count": 3, "color": 65280, "disable": false }, { "index": 2, // The same index will be overwritten "count": 3, "color": 16711680, "disable": false } ] }
}
```

## 12. Add/Update effect

**Request params**:

`POST /v1/oauth/resources/device/effect/save`

```
{
"deviceId": "<device-id>", "payload": { "id": -1 "name": "xxxx", "category": 1/2, "mode": 0, "speed": 100, "brightness": 100,
"pixelLen": 10, "reverse": false, "pixels": [ { "index": 0, "count": 5, "color": 16711680, // (0xFF0000) "disable": false }, { "index": 1, "count": 10, "color": 16711680, "disable": false } ] }
}
```

**Effect fields details**:

| Field       | Description                                                                                                                                                                         | Type    |
| :---------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------ |
| id          | Effect ID. If ID is -1 or null, it will be saved as a new effect, if not, the effect corresponding to the ID will be updated. Up to 60 effects can be saved.                         | Integer |
| category   | Effect category. 0 : build-in effect. 1 : custom effect.                                                                                                                          | Integer |
| mode        | Effect mode. Custom effect mode range: \. \                                                                                                                            | Integer |
| speed       | Effect speed. Speed range: \.                                                                                                                                             | Integer |
| brightness  | Effect brightness. Brightness range: \.                                                                                                                                  | Integer |
| pixelLen    | Effect pixel length. Pixel length range: \. (Only required for build-in effects)                                                                                           | Integer |
| reverse     | Reverse effect. (Only required for build-in effects)                                                                                                                             | Boolean |
| pixels      | Custom effect pixels. See pixel fields details. (Only required for custom effects)                                                                                              | List   |

**Response result**:

```
{
"code": 0, "desc": "success", "payload": { "id": 10 // effect id }
}
```

## 13. Check out effect

**Request params**:

`POST /v1/oauth/resources/device/effect/view`

```
{
"deviceId": "<device-id>", "payload": { "id": 0 }
}
```

**Response result**:

```
{
"code": 0, "desc": "success"
}
```

## 14. Delete effect

**Request prams**:

`POST /v1/oauth/resources/device/effect/delete`

```
{
"deviceId": "<device-id>", "payload": { "id": 0 }
}
```

**Response result**:

```
{
"code": 0, "desc": "success"
}
```

## 15. Update daily schedule

**Request prams**:

`POST /v1/oauth/resources/device/daily/save`

```
{
"deviceId": "<device-id>", "payload": { "id": 1, "enable": true, "effectId": 1, "repetition": 1, "startTime": { "hours": 10, "minutes": 1 }, "endTime": { "hours": 11, "minutes": 1 }, "currentDate": { "month": 1, "day": 1 } }
}
```

**Response result**:

```
{
"code": 0, "desc": "success"
}
```

## 16. Add/Update calendar schedule

**Request prams**:

`POST /v1/oauth/resources/device/calendar/save`

```
{
"deviceId": "<device-id>", "payload": { "id": 0, "effectId": 1, // The combined effect id is fixed at 200 "startDate": { "month": 12, "day": 31 }, "endDate": { "month": 1, "day": 1 }, "startTime": { "hours": 10, "minutes": 1 }, "endTime": { "hours": 11, "minutes": 1 } }
}
```

**Response result**:

```
{
"code": 0, "desc": "success"
}
```

## 17. Delete calendar schedule

**Request prams**:

`POST /v1/oauth/resources/device/calendar/delete`

```
{
"deviceId": "<device-id>", "payload": { "id": 0 }
}
```

**Response result**:

```
{
"code": 0, "desc": "success", "payload": { "id": 10 // calendar id }
}
```

## 18. Set combined effect

**Request prams**:

`POST /v1/oauth/resources/device/combined-effect/save`

```
{
"deviceId": "<device-id>", "payload": { "effectIds":, // up to 5 effects "interval": 5
}
}
```

**Response result**:

```
{
"code": 0, "desc": "success"
}
```

## 19. Get group list

**Request params**:

`GET /v1/oauth/resources/groups`

```
{
"page": 1 // 10 groups on one page // If the value is 0 or null, it will return to the list of all groups
}
```

**Response result**:

```
{
"code": 0,
"desc": "success",
"payload": {
"total": 2,
"current": 1,
"data": [
{ "groupId": "xxx", "name": "group1", "masterDevice": { "deviceId": "<device_id>", "name": "<device_name>" }, "devices": [ { "deviceId": "<device_id>", "name": "<device_name>" } ] }, { "groupId": "xxx", "name": "group2", "masterDevice": { "deviceId": "<device_id>", "name": "<device_name>" }, "devices": [ { "deviceId": "<device_id>", "name": "<device_name>" } ] } ] }
}
```

## 20. Add a new group

**Request params**:

`GET /v1/oauth/resources/group/add`

```
{
"name": "<new group name>", "masterDevice": "<master device ID>", "devices": [
"<master device ID>", "<device ID>", "<device ID>" ]
}
```

**Response result**:

```
{
"code": 0,
"desc": "success",
"payload": {
"groupId": "<new group ID>"
}
}
```

## 21. Update a group

**Request params**:

`GET /v1/oauth/resources/group/update`

```
{
"groupId": "<group ID>", "masterDevice": "<master device ID>", "devices": [
"<master device ID>", "<device ID>", "<device ID>" ]
}
```

**Response result**:

```
{
"code": 0,
"desc": "success",
"payload": {
"groupId": "<new group ID>"
}
}
```

## 22. Rename a group

**Request params**:

`GET /v1/oauth/resources/group/rename`

```
{
"groupId": "<group ID>", "name": "<new group name>"
}
```

**Response result**:

```
{
"code": 0,
"desc": "success"
}
```

## 23. Delete a group

**Request params**:

`GET /v1/oauth/resources/group/delete`

```
{
"groupId": "<group ID>"
}
```

**Response result**:

```
{
"code": 0,
"desc": "success"
}
```

## 24. Sync a group

**Request params**:

`GET /v1/oauth/resources/group/sync`

```
{
"groupId": "<group ID>"
}
```

**Response result**:

```
{
"code": 0,
"desc": "success"
}
```

PS: The master device must be online.

## 25. Notify update shadow data

Before requesting detailed data for the device, you can send this request to notify the device to report the latest shadow data.

**Request params**:

`GET /v1/oauth/resources/device/notify-update-shadow`

```
{
"deviceId": "<device-id>", "currentDate": { "year": 21, // 2021 "month": 1, "day": 1, "weekday": 1, "hours": 1, "minutes": 1, "seconds": 1 }
}
```

**Response result**:

```
{
"code": 0,
"desc": "success"
}
```

## Appendix

#### \ Result code

| Code    | Description |
| :------ | :---------- |
| 0       | Success.    |
| 10001  | Error.      |
| 10002  | Wrong password. |

#### \ Color order

| Color order            | Value |
| :---------------------- | :---- |
| RGB                    | 0     |
| RBG                    | 1     |
| GRB                    | 2     |
| GBR                    | 3     |
| BRG                    | 4     |
| BGR                    | 5     |

#### \ IC

| IC        | Value |
| :--------- | :---- |
| UCS1903    | 0     |
| DMX512    | 1     |

#### \ Build-in effect mode

| Color order                | Value |
| :-------------------------- | :---- |
| Rainbow Gradual Chase     | 0     |
| Rainbow Comet             | 1     |
| Rainbow Segment            | 2     |
| Rainbow Wave               | 3     |
| Rainbow Meteor             | 4     |
| Rainbow Gradual            | 5     |
| Rainbow Jump               | 6     |
| Rainbow Stars              | 7     |
| Rainbow Fade In Out        | 8     |
| Rainbow Spin               | 9     |
| Red Stacking              | 10    |
| Green Stacking             | 11    |
| Blue Stacking              | 12    |
| Yellow Stacking            | 13    |
| Cyan Stacking              | 14    |
| Purple Stacking            | 15    |
| White Stacking             | 16    |
| Full Color Stack           | 17    |
| Red to Green Stack         | 18    |
| Green to Blue Stack         | 19    |
| Blue to Yellow Stack        | 20    |
| Yellow to Cyan Stack        | 21    |
| Cyan to Purple Stack        | 22    |
| Purple to White Stack        | 23    |
| Red Comet                 | 24    |
| Green Comet                | 25    |
| Blue Comet                 | 26    |
| Yellow Comet                | 27    |
| Cyan Comet                 | 28    |
| Purple Comet                | 29    |
| White Comet                | 30    |
| Red Meteor                 | 31    |
| Green Meteor                | 32    |
| Blue Meteor                 | 33    |
| Yellow Meteor                | 34    |
| Cyan Meteor                 | 35    |
| Purple Meteor                | 36    |
| White Meteor                | 37    |
| Red Wave                   | 38    |
| Green Wave                  | 39    |
| Blue Wave                   | 40    |
| Yellow Wave                  | 41    |
| Cyan Wave                   | 42    |
| Purple Wave                  | 43    |
| White Wave                  | 44    |
| Red Green Wave              | 45    |
| Red Blue Wave               |
