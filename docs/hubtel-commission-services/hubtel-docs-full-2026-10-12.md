# Hubtel Commission Services — official docs (full text)

> Saved verbatim from the user's paste on 2026-10-13 (Hubtel page "Last updated October 12th, 2026").
> Only the docs-site widget noise was removed (the "HTTP / cURL / PHP / Python / JS" language tabs and "copy Copy" buttons).
> The first paste was truncated mid ECG Top-Up; the remainder (ECG, Ghana Water, Status Check, response codes) was pasted
> separately the same day and merged in, so this file is now the **complete** page. Telecel Postpaid Bills has a ServiceID
> but no endpoint section in Hubtel's docs.
>
> Companion files: `api-reference.md` (condensed notes, includes status check + response codes), `runbook.md` (Phase 1 rollout).

---

## Overview

The Hubtel Commission Services API is a set of developer tools and products that help businesses, financial organizations and individuals to facilitate bill payments, airtime top-ups and other digital services for customers.

## Base Endpoint

All requests to the Commission Services API will be sent to the base URLs below with the corresponding parameter formats.

| Parameter | Value |
|---|---|
| BaseURL | `https://cs.hubtel.com/commissionservices` |
| Disbursement Account Number | `{Disbursement_Account_Number}` |
| ServiceID | `{serviceID}` |
| Content Type | JSON |

Generic Commission Services Endpoint URL looks like this:

```
{BaseUrl}/{Disbursement_Account_Number}/{ServiceID}
```

Example:

```
https://cs.hubtel.com/commissionservices/11691/fdd76c884e614b1c8f669a3207b09a98
```

## ServiceIDs

| ServiceID | Description |
|---|---|
| fdd76c884e614b1c8f669a3207b09a98 | MTN Airtime |
| f4be83ad74c742e185224fdae1304800 | Telecel Airtime |
| dae2142eb5a14c298eace60240c09e4b | AirtelTigo Airtime |
| e6d6bac062b5499cb1ece1ac3d742a84 | ECG Prepaid & PostPaid |
| b9a1aa246ba748f9ba01ca4cdbb3d1d3 | Telecel Broadband |
| b230733cd56b4a0fad820e39f66bc27c | MTN Data |
| fa27127ba039455da04a2ac8a1613e00 | Telecel Data |
| 06abd92da459428496967612463575ca | AirtelTigo Data |
| 297a96656b5846ad8b00d5d41b256ea7 | DSTV |
| e6ceac7f3880435cb30b048e9617eb41 | GOtv |
| a3ab78c84c6b4976b78a6f393e247a72 | Telecel Postpaid Bills |
| 6c1e8a82d2e84feeb8bfd6be2790d71d | Ghana Water |
| 6598652d34ea4112949c93c079c501ce | StarTimes TV |

## Getting Started

### Understanding the Service Flow

The Hubtel Sales API allows you to integrate multiple functionalities into your applications. This document focuses on:

- **Commission Services endpoints:** REST API to either query one of the service endpoints or make a bill payment.
- **Status Check API:** REST API to check for the status of a Commissions Service transaction initiated previously after five (5) or more minutes of the transaction's completion. It is mandatory to implement the Transaction Status Check API only for transactions that you do not receive a callback from Hubtel.

The entire process is asynchronous. The figure below demonstrates the service flow using these two endpoints: *(figure not captured)*

The table below outlines the steps involved in the Commissions Service API:

| Step | Description |
|---|---|
| 1 | Client App makes a Commissions Service request to Hubtel. |
| 2 | Hubtel performs authentication on the request and sends a response to Client App accordingly. |
| 3 | A final callback is sent to Client App via the CallbackURL provided in the request. |
| 4 | In instances where a merchant does not receive the final status of the transaction after five (5) minutes from Hubtel, it is mandatory to do a status check using the Status Check API to determine the final status of the transaction. |

## API Reference

The core services are broken down into three main kinds: Airtime Top-ups, Data Bundles and Utility Payments. The details of how to integrate with each of the services can be found below.

**It's also mandatory to pass your Disbursement Account Number for every Commission Service request in the URL.** Replace "{Disbursement_Account_Number}" in the endpoint "https://cs.hubtel.com/commissionservices/{Disbursement_Account_Number}/" with your Disbursement Account Number. Find your Disbursement Account Number here. *(link not captured)*

---

## Airtime Top-Ups

> **Note:** The maximum airtime top-up amount per request is 100 cedis.

### MTN Airtime Top-Up

This endpoint is used to top up an MTN account with Airtime.

| | |
|---|---|
| API Endpoint | `https://cs.hubtel.com/commissionservices/{Disbursement_Account_Number}/fdd76c884e614b1c8f669a3207b09a98` |
| Request Type | POST |
| Content Type | JSON |

**REQUEST PARAMETERS**

| Parameter | Type | Requirement | Description |
|---|---|---|---|
| Destination | String | Mandatory | The destination account to receive the airtime value. |
| Amount | Float | Mandatory | The airtime value to be sent during this transaction. NB: Only 2 decimal places is allowed E.g.: 0.50. |
| CallbackUrl | String | Mandatory | Used to receive the callback for the transaction from Hubtel. See below for a sample callback. |
| ClientReference | String | Mandatory | The reference number that is provided by the API user. |

**RESPONSE PARAMETERS**

| Parameter | Type | Description |
|---|---|---|
| ResponseCode | String | The unique response code on the status of the transaction. |
| Message | String | The description of the response received from the API call that is related to the ResponseCode. |
| Data | Object | An object containing the required data response from the API. |
| ClientReference | String | The reference number that was initially provided by the API user in the request payload. |
| Amount | Float | The transaction amount, minus the charges/fees. |
| TransactionId | String | The unique ID to identify a transaction. |
| Meta | Object | Object that contains Commission key. |
| Commission | String | The commission gained for the transaction. |

**SAMPLE REQUEST**

```http
POST /commissionservices/11691/fdd76c884e614b1c8f669a3207b09a98 HTTP/1.1
Host: cs.hubtel.com
Accept: application/json
Content-Type: application/json
Authorization: Basic endjeOBiZHhza250fT3==

{
    "Destination": "233246912184",
    "Amount": 0.5,
    "CallbackUrl": "https://webhook.site/fcad8efa-624b-44c8-a129-b1c01921191d",
    "ClientReference": "TestEVD01011"
}
```

**SAMPLE RESPONSE** — 200 OK

```json
{
  "ResponseCode": "0001",
  "Message": "Transaction pending. Expect callback request for final state",
  "Data": {
      "ClientReference": "TestEVD01011",
      "Amount": 0.85,
      "TransactionId": "a50e003d8d8741d49a3a0dc677a7576b",
      "Meta": {
          "Commission": "0.05"
      }
  }
}
```

### Telecel Airtime Top-Up

This endpoint is used to top up an Telecel account with Airtime.

| | |
|---|---|
| API Endpoint | `https://cs.hubtel.com/commissionservices/{Disbursement_Account_Number}/f4be83ad74c742e185224fdae1304800` |
| Request Type | POST |
| Content Type | JSON |

**REQUEST PARAMETERS**

| Parameter | Type | Requirement | Description |
|---|---|---|---|
| Destination | String | Mandatory | The destination account to receive the airtime value. |
| Amount | Float | Mandatory | The airtime value to be sent during this transaction. Eg: 0.5 |
| CallbackUrl | String | Mandatory | Used to receive the callback for the transaction from Hubtel. See below for a sample callback. |
| ClientReference | String | Mandatory | The reference number that is provided by the API user. |

**RESPONSE PARAMETERS**

| Parameter | Type | Description |
|---|---|---|
| ResponseCode | String | The unique response code on the status of the transaction. |
| Message | String | The description of the response received from the API call that is related to the ResponseCode. |
| Data | Object | An object containing the required data response from the API. |
| ClientReference | String | The reference number that was initially provided by the API user in the request payload. |
| Amount | Float | The transaction amount, minus the charges/fees |
| TransactionId | String | The unique ID to identify a transaction. |
| Meta | Object | Object that contains Commission key. |
| Commission | String | The commission gained for the transaction. |

**SAMPLE REQUEST**

```http
POST /commissionservices/11691/f4be83ad74c742e185224fdae1304800 HTTP/1.1
Host: cs.hubtel.com
Accept: application/json
Content-Type: application/json
Authorization: Basic endjeOBiZHhza250fT3==

{
    "Destination": "233206439599",
    "Amount": 0.5,
    "CallbackUrl": "https://webhook.site/fcad8efa-624b-44c8-a129-b1c01921191d",
    "ClientReference": "TestEVD01021"
}
```

**SAMPLE RESPONSE** — 200 OK

```json
{
  "ResponseCode": "0001",
  "Message": "Transaction pending. Expect callback request for final state",
  "Data": {
      "ClientReference": "TestEVD01021",
      "Amount": 0.85,
      "TransactionId": "0305e0d79b2048e5b57647d4acaff939",
      "Meta": {
          "Commission": "0.0280"
      }
  }
}
```

### AT Airtime Top-Up

This endpoint is used to top up an AT account with Airtime.

| | |
|---|---|
| API Endpoint | `https://cs.hubtel.com/commissionservices/{Disbursement_Account_Number}/dae2142eb5a14c298eace60240c09e4b` |
| Request Type | POST |
| Content Type | JSON |

**REQUEST PARAMETERS**

| Parameter | Type | Requirement | Description |
|---|---|---|---|
| Destination | String | Mandatory | The destination account to receive the airtime value. |
| Amount | Float | Mandatory | The airtime value to be sent during this transaction. Eg: 0.5 |
| CallbackUrl | String | Mandatory | Used to receive the callback for the transaction from Hubtel. See below for a sample callback. |
| ClientReference | String | Mandatory | The reference number that is provided by the API user. |

**RESPONSE PARAMETERS**

| Parameter | Type | Description |
|---|---|---|
| ResponseCode | String | The unique response code on the status of the transaction. |
| Message | String | The description of the response received from the API call that is related to the ResponseCode. |
| Data | Object | An object containing the required data response from the API. |
| ClientReference | String | The reference number that was initially provided by the API user in the request payload. |
| Amount | Float | The transaction amount, minus the charges/fees. |
| TransactionId | String | The unique ID to identify a transaction. |
| Meta | Object | Object that contains Commission key. |
| Commission | String | The commission gained for the transaction. |

**SAMPLE REQUEST**

```http
POST /commissionservices/11691/dae2142eb5a14c298eace60240c09e4b HTTP/1.1
Host: cs.hubtel.com
Accept: application/json
Content-Type: application/json
Authorization: Basic endjeOBiZHhza250fT3==

{
    "Destination": "233574126849",
    "Amount": 0.5,
    "CallbackUrl": "https://webhook.site/fcad8efa-624b-44c8-a129-b1c01921191d",
    "ClientReference": "TestEVD01027"
}
```

**SAMPLE RESPONSE** — 200 OK

```json
{
  "ResponseCode": "0001",
  "Data": {
      "ClientReference": "TestEVD01027",
      "Amount": 0.85,
      "TransactionId": "a1579b60845444babfe13945660a679d",
      "Meta": {
          "Commission": "0.35"
      }
  }
}
```

---

## Data & Voice Bundle Services

> **Note:** The data bundle packages are subject to change by the telco. Be sure to query the packages before initiating a top-up request.

### MTN Data Bundle Query

This queries the MTN Data bundle service for the available bundles which can be purchased for a specific number.

| | |
|---|---|
| API Endpoint | `https://cs.hubtel.com/commissionservices/{Disbursement_Account_Number}/b230733cd56b4a0fad820e39f66bc27c?destination={RecipientNumber}` |
| Request Type | GET |
| Content Type | JSON |

**REQUEST PARAMETERS**

| Parameter | Type | Requirement | Description |
|---|---|---|---|
| Destination | String | Mandatory | The destination number which will be receiving the data bundle value. This parameter is to be placed in the URL. Not in the request body. |

**RESPONSE PARAMETERS**

| Parameter | Type | Description |
|---|---|---|
| ResponseCode | String | The unique response code on the status of the transaction. |
| Message | String | The description of the response received from the API call that is related to the ResponseCode. |
| Label | String | The response label from the service provider. Usually the same as the message. |
| Data | ArrayOfObjects | This is an Array of objects that show of different bundle packages |
| Display | String | The display key for the bundle. |
| Value | String | The value of the data bundle. The desired value will then be used in the request body of the MTN Data topup endpoint. |
| Amount | Float | The transaction amount. The actual cost of the data bundle. |

**SAMPLE REQUEST**

```http
GET /commissionservices/11691/b230733cd56b4a0fad820e39f66bc27c?destination=233246912184 HTTP/1.1
Host: cs.hubtel.com
Accept: application/json
Content-Type: application/json
Authorization: Basic endjeOBiZHhza250fT3==
```

**SAMPLE RESPONSE** — 200 OK

```json
{
  "ResponseCode": "0000",
  "Message": "Successful",
  "Label": "Successful",
  "Data": [
      { "Display": "17.79MB", "Value": "data_bundle_1", "Amount": 0.5 },
      { "Display": "Kokrokoo 400MB, 5am to 8am", "Value": "kokrokoo_bundle_1", "Amount": 1.24 },
      { "Display": "35.57MB", "Value": "data_bundle_2", "Amount": 1.0 },
      { "Display": "349.24MB", "Value": "data_bundle_3", "Amount": 3.0 },
      { "Display": "718.91MB", "Value": "data_bundle_4", "Amount": 10.0 },
      { "Display": "1.19GB", "Value": "flexi_data_bundle", "Amount": 20.0 },
      { "Display": "2.38GB", "Value": "flexi_data_bundle", "Amount": 40.0 },
      { "Display": "3.58GB", "Value": "flexi_data_bundle", "Amount": 60.0 },
      { "Display": "4.77GB", "Value": "flexi_data_bundle", "Amount": 80.0 },
      { "Display": "7.87GB", "Value": "flexi_data_bundle", "Amount": 100.0 },
      { "Display": "9.44GB", "Value": "flexi_data_bundle", "Amount": 120.0 },
      { "Display": "11.80GB", "Value": "flexi_data_bundle", "Amount": 150.0 },
      { "Display": "26.50GB", "Value": "flexi_data_bundle", "Amount": 200.0 },
      { "Display": "33.13GB", "Value": "flexi_data_bundle", "Amount": 250.0 },
      { "Display": "39.62GB", "Value": "flexi_data_bundle", "Amount": 299.0 },
      { "Display": "92.88GB", "Value": "flexi_data_bundle", "Amount": 350.0 },
      { "Display": "Video 135.69MB", "Value": "video_bundle_1", "Amount": 1.0 },
      { "Display": "Video 678.43MB", "Value": "video_bundle_2", "Amount": 5.0 },
      { "Display": "Video 1.33GB", "Value": "video_bundle_3", "Amount": 10.0 },
      { "Display": "Social Media 70.87MB", "Value": "social_media_bundle_1", "Amount": 1.0 },
      { "Display": "Social Media 354.36MB", "Value": "social_media_bundle_2", "Amount": 5.0 },
      { "Display": "Social Media 708.72MB", "Value": "social_media_bundle_3", "Amount": 10.0 }
  ]
}
```

### MTN Data Bundle Top-Up

This endpoint is used to top up an MTN account with a data bundle.

| | |
|---|---|
| API Endpoint | `https://cs.hubtel.com/commissionservices/{Disbursement_Account_Number}/b230733cd56b4a0fad820e39f66bc27c` |
| Request Type | POST |
| Content Type | JSON |

**REQUEST PARAMETERS**

| Parameter | Type | Requirement | Description |
|---|---|---|---|
| Destination | String | Mandatory | The destination account to receive the data bundle value. |
| Amount | Float | Mandatory | The cost of the data bundle being purchased. This amount is known by querying for the available data bundles to purchase. |
| CallbackUrl | String | Mandatory | Used to receive the callback for the transaction from Hubtel. See below for a sample callback. |
| ClientReference | String | Mandatory | The reference number that is provided by the API user. |
| Extradata | Object | Mandatory | This Object contains bundle name/key. |
| Bundle | String | Mandatory | The desired bundle being purchased. This parameter is taken from the "value" response parameter on the MTN Data Bundle Query Endpoint. Note: If the Bundle and the amount do not correspond to what is taken from the Data Bundle Query endpoint, the transaction will fail. |

**RESPONSE PARAMETERS**

| Parameter | Type | Description |
|---|---|---|
| ResponseCode | String | The unique response code on the status of the transaction. |
| Message | String | The description of the response received from the API call that is related to the ResponseCode. |
| Data | Object | This is an object that contains the parameters below. |
| ClientReference | String | The reference number that was initially provided by the API user in the request payload. |
| Amount | Float | The transaction amount, minus the charges/fees. |
| TransactionId | String | The unique ID to identify a transaction. |
| Meta | Object | This is an object that contains the Commission parameter. |
| Commission | String | The commission gained for the transaction. |

**SAMPLE REQUEST**

```http
POST /commissionservices/11691/b230733cd56b4a0fad820e39f66bc27c HTTP/1.1
Host: cs.hubtel.com
Accept: application/json
Content-Type: application/json
Authorization: Basic endjeOBiZHhza250fT3==

{
    "Destination": "233246912184",
    "Amount": 0.5,
    "CallbackUrl": "https://webhook.site/fcad8efa-624b-44c8-a129-b1c01921191d",
    "ClientReference": "TestDATA01013",
    "Extradata": {
        "bundle": "data_bundle_1"
    }
}
```

**SAMPLE RESPONSE** — 200 OK

```json
{
  "ResponseCode": "0001",
  "Message": "Transaction pending. Expect callback request for final state.",
  "Data": {
      "ClientReference": "TestDATA01013",
      "Amount": 0.5,
      "TransactionId": "5b40e2e40fd4441d80b69b352f3103c7",
      "Meta": {
          "Commission": "0.0198"
      }
  }
}
```

**SAMPLE CALLBACK**

```json
{
  "ResponseCode": "0000",
  "Data": {
      "AmountDebited": 0.5,
      "TransactionId": "5b40e2e40fd4441d80b69b352f3103c7",
      "ClientReference": "TestDATA01013",
      "Description": "GHC 0.50 (data_bundle_1) has been sent to 233242825109 on January 24, 2024.",
      "ExternalTransactionId": "2024012416592042208544402",
      "Amount": 0.5,
      "Charges": 0,
      "Meta": {
          "Commission": "0.0198"
      },
      "RecipientName": null
  }
}
```

> **Note:** Businesses that want to add an extra layer of security to ensure callbacks reach their endpoint securely can whitelist Hubtel's callback IP address: 18.202.122.131

### Telecel Data Query

This queries the Telecel Data Bundle Service for the available bundles which can be purchased for a specific number.

| | |
|---|---|
| API Endpoint | `https://cs.hubtel.com/commissionservices/{Disbursement_Account_Number}/fa27127ba039455da04a2ac8a1613e00?destination={RecipientNumber}` |
| Request Type | GET |
| Content Type | JSON |

**REQUEST PARAMETERS**

| Parameter | Type | Requirement | Description |
|---|---|---|---|
| Destination | String | Mandatory | The destination number which will be receiving the data bundle value. This parameter is to be placed in the URL. Not in the request body. |

**RESPONSE PARAMETERS**

| Parameter | Type | Description |
|---|---|---|
| ResponseCode | String | The unique response code on the status of the transaction. |
| Message | String | The description of the response received from the API call that is related to the ResponseCode. |
| Label | String | The response label from the service provider. Usually the same as the message. |
| Data | ArrayOfObjects | This is an Array of objects that show of different bundle packages. |
| Display | String | The display key for the bundle. |
| Value | String | The value of the data bundle. The desired value will then be used in the request body of the Telecel Data topup endpoint. |
| Amount | Float | The transaction amount. The actual cost of the data bundle. |

**SAMPLE REQUEST**

```http
GET /commissionservices/11691/fa27127ba039455da04a2ac8a1613e00?destination=233206439599 HTTP/1.1
Host: cs.hubtel.com
Accept: application/json
Content-Type: application/json
Authorization: Basic endjeOBiZHhza250fT3==
```

**SAMPLE RESPONSE** — 200 OK

```json
{
  "ResponseCode": "0000",
  "Message": "Successful",
  "Label": "Successful",
  "Data": [
      { "Display": " Dual Recharge", "Value": " 5.7 GB", "Amount": 50.0 },
      { "Display": "Chat Monthly", "Value": "2 GB", "Amount": 20.0 },
      { "Display": "Starter Monthly", "Value": "560 MB", "Amount": 10.0 },
      { "Display": " Streamer Weekly", "Value": "460 MB", "Amount": 5.0 },
      { "Display": "Browser Daily", "Value": "61 MB", "Amount": 1.0 },
      { "Display": " Starter Daily", "Value": "25 MB", "Amount": 0.5 }
  ]
}
```

### Telecel Data Bundle Top-Up

This endpoint is used to top up a Telecel account with a data bundle.

| | |
|---|---|
| API Endpoint | `https://cs.hubtel.com/commissionservices/{Disbursement_Account_Number}/fa27127ba039455da04a2ac8a1613e00` |
| Request Type | POST |
| Content Type | JSON |

**REQUEST PARAMETERS**

| Parameter | Type | Requirement | Description |
|---|---|---|---|
| Destination | String | Mandatory | The destination account to receive the data bundle value. |
| Amount | Float | Mandatory | The cost of the data bundle being purchased. This amount is known by querying for the available data bundles to purchase. |
| CallbackUrl | String | Mandatory | Used to receive the callback for the transaction from Hubtel. See below for a sample callback. |
| ClientReference | String | Mandatory | The reference number that is provided by the API user. |
| Extradata | Object | Mandatory | This Object contains bundle name/key. |
| Bundle | String | Mandatory | The desired bundle being purchased. This parameter is taken from the "value" response parameter on the MTN Data Bundle Query Endpoint. Note: If the Bundle and the amount do not correspond to what is taken from the Data Bundle Query endpoint, the transaction will fail. |

**RESPONSE PARAMETERS**

| Parameter | Type | Description |
|---|---|---|
| ResponseCode | String | The unique response code on the status of the transaction. |
| Message | String | The description of the response received from the API call that is related to the ResponseCode. |
| ClientReference | String | The reference number that was initially provided by the API user in the request payload. |
| Amount | Float | The transaction amount, minus the charges/fees. |
| TransactionId | String | The unique ID to identify a transaction. |
| Commission | String | The commission gained for the transaction. |

**SAMPLE REQUEST**

```http
POST /commissionservices/11691/fa27127ba039455da04a2ac8a1613e00 HTTP/1.1
Host: cs.hubtel.com
Accept: application/json
Content-Type: application/json
Authorization: Basic endjeOBiZHhza250fT3==

{
    "Destination": "233206439419",
    "Amount": 0.5,
    "CallbackUrl": "https://webhook.site/fcad8efa-624b-44c8-a129-b1c01921191d",
    "ClientReference": "TestDATA01025",
    "Extradata": {
        "bundle": "25 MB"
    }
}
```

**SAMPLE RESPONSE** — 200 OK

```json
{
  "ResponseCode": "0001",
  "Message": "Transaction pending. Expect callback request for final state",
  "Data": {
      "ClientReference": "TestDATA01025",
      "Amount": 1,
      "TransactionId": " 558625e7f8c94feb82ddf50cb33bc557",
      "Meta": {
          "Commission": "0.0140"
      }
  }
}
```

**SAMPLE CALLBACK**

```json
{
  "ResponseCode": "0000",
  "Data": {
      "AmountDebited": 1,
      "TransactionId": "d28c20baebdc44f19be7b62c922ac9c6",
      "ClientReference": "TestDATAwithkaks",
      "Description": "OK : ",
      "ExternalTransactionId": "767732a31701457c99bfcfad773fbedd",
      "Amount": 1,
      "Charges": 0,
      "Meta": {
          "Commission": "0.0269"
      },
      "RecipientName": null
  }
}
```

> **Note:** Businesses that want to add an extra layer of security to ensure callbacks reach their endpoint securely can whitelist Hubtel's callback IP address: 18.202.122.131

### Telecel Broadband Query

This queries the Telecel Broadband service to get the details of a Broadband account.

| | |
|---|---|
| API Endpoint | `https://cs.hubtel.com/commissionservices/{Disbursement_Account_Number}/b9a1aa246ba748f9ba01ca4cdbb3d1d3?destination={RecipientNumber}` |
| Request Type | GET |
| Content Type | JSON |

**REQUEST PARAMETERS**

| Parameter | Type | Requirement | Description |
|---|---|---|---|
| Destination | String | Mandatory | The landline number on the broadband account. E.g.: "0302450262" |

**RESPONSE PARAMETERS**

| Parameter | Type | Description |
|---|---|---|
| ResponseCode | String | The unique response code on the status of the transaction. |
| Message | String | The description of the response received from the API call that is related to the ResponseCode. |
| Label | String | The response label from the service provider. Usually the same as the message. |
| Data | ArrayOfObjects | This is an Array of objects that contains info on the account. |
| Display | String | The display key for the account detail. Eg: name, account, etc. |
| Value | String | This shows the actual account detail of the "Display" parameter. E.g: the Account name (John Manu) is shown under a display key of value "name". |
| Amount | Float | The amount. This parameter is usually zero. |

**SAMPLE REQUEST**

```http
GET /commissionservices/11691/b9a1aa246ba748f9ba01ca4cdbb3d1d3?destination=0302450262 HTTP/1.1
Host: cs.hubtel.com
Accept: application/json
Content-Type: application/json
Authorization: Basic endjeOBiZHhza250fT3==
```

**SAMPLE RESPONSE** — 200 OK

```json
{
  "ResponseCode": "0000",
  "Message": "Successful",
  "Label": "",
  "Data": [
    { "Display": "name", "Value": "BOATENG PHILIP NANA BEDIAKO", "Amount": 0.0 },
    { "Display": "amountDue", "Value": "0.00", "Amount": 0.0 },
    { "Display": "account", "Value": "0302450262", "Amount": 0.0 }
  ]
}
```

### Telecel Broadband Top-Up

This endpoint is used to top up a Telecel broadband account.

| | |
|---|---|
| API Endpoint | `https://cs.hubtel.com/commissionservices/{Disbursement_Account_Number}/b9a1aa246ba748f9ba01ca4cdbb3d1d3` |
| Request Type | POST |
| Content Type | JSON |

**REQUEST PARAMETERS**

| Parameter | Type | Requirement | Description |
|---|---|---|---|
| Destination | String | Mandatory | The landline number on the broadband account. E.g.: "0302450262" |
| Amount | Float | Mandatory | The top-up amount. |
| CallbackUrl | String | Mandatory | Used to receive the callback for the transaction from Hubtel. See below for a sample callback. |
| ClientReference | String | Mandatory | A unique string identifying the transaction. |
| Extradata | Object | Mandatory | This Object contains bundle name/key. |
| Bundle | String | Mandatory | The broadband number. |

**RESPONSE PARAMETERS**

| Parameter | Type | Description |
|---|---|---|
| ResponseCode | String | The unique response code on the status of the transaction. |
| Message | String | The description of the response received from the API call that is related to the ResponseCode. |
| ClientReference | String | The reference number that was initially provided by the API user in the request payload. |
| Amount | Float | The transaction amount, minus the charges/fees. |
| TransactionId | String | The unique ID to identify a transaction. |
| Commission | String | The commission gained for the transaction. |

**SAMPLE REQUEST**

```http
POST /commissionservices/11691/b9a1aa246ba748f9ba01ca4cdbb3d1d3 HTTP/1.1
Host: cs.hubtel.com
Accept: application/json
Content-Type: application/json
Authorization: Basic endjeOBiZHhza250fT3==

{
    "Destination": "0302450262",
    "Amount": 1.0,
    "CallbackUrl": "https://webhook.site/fcad8efa-624b-44c8-a129-b1c01921191d",
    "ClientReference": "567680374084840678",
    "Extradata": {
        "bundle": "P0444101"
    }
}
```

**SAMPLE RESPONSE** — 200 OK

```json
{
  "ResponseCode": "0001",
  "Message": "Transaction pending. Expect callback request for final state.",
  "Data": {
      "ClientReference": "567680374084840678",
      "Amount": 1.0,
      "TransactionId": "f12b0054fe884769910e187cac833ba1",
      "Meta": {
          "Commission": "0.0000"
      }
  }
}
```

**SAMPLE CALLBACK**

```json
{
  "ResponseCode": "0000",
  "Data": {
    "AmountDebited": 1,
    "TransactionId": "f12b0054fe884769910e187cac833ba1",
    "ClientReference": "567680374084840678",
    "Description": "Status: ADSL[0302450262] Successful; Other Details: 0#09FG08211340576120512#1.00#2.00Operation successfully.; Reference: 09FG08211340576120512",
    "ExternalTransactionId": "09FG08211340576120512",
    "Amount": 1,
    "Charges": 0,
    "Meta": {
      "Commission": "0.0000"
    },
    "RecipientName": null
  }
}
```

> **Note:** Businesses that want to add an extra layer of security to ensure callbacks reach their endpoint securely can whitelist Hubtel's callback IP address: 18.202.122.131

### AT Data Bundle Query

This queries the AT Data Bundle Service for the available bundles which can be purchased for a specific number.

| | |
|---|---|
| API Endpoint | `https://cs.hubtel.com/commissionservices/{Disbursement_Account_Number}/06abd92da459428496967612463575ca?destination={RecipientNumber}` |
| Request Type | GET |
| Content Type | JSON |

**REQUEST PARAMETERS**

| Parameter | Type | Requirement | Description |
|---|---|---|---|
| Destination | String | Mandatory | The destination number which will be receiving the data bundle value. This parameter is to be placed in the URL. Not in the request body. |

**RESPONSE PARAMETERS**

| Parameter | Type | Description |
|---|---|---|
| ResponseCode | String | The unique response code on the status of the transaction. |
| Message | String | The description of the response received from the API call that is related to the ResponseCode. |
| Label | String | The response label from the service provider. Usually the same as the message. |
| Data | ArrayOfObjects | This is an Array of objects that show of different bundle packages |
| Display | String | The display key for the bundle. |
| Value | String | The value of the data bundle. The desired value will then be used in the request body of the AT Data top-up endpoint. |
| Amount | Float | The transaction amount. The actual cost of the data bundle. |

**SAMPLE REQUEST**

```http
GET /commissionservices/11691/06abd92da459428496967612463575ca?destination=233273833933 HTTP/1.1
Host: cs.hubtel.com
Accept: application/json
Content-Type: application/json
Authorization: Basic endjeOBiZHhza250fT3==
```

**SAMPLE RESPONSE** — 200 OK

```json
{
  "ResponseCode": "0000",
  "Message": "Successful",
  "Label": "Select bundle",
  "Data": [
      { "Display": "80MB Bundle (GHS 1)", "Value": "DATA1", "Amount": 1.0 },
      { "Display": "200MB Bundle (GHS 2", "Value": "DATA2", "Amount": 2.0 },
      { "Display": "650MB Bundle (GHS 5)", "Value": "DATA5", "Amount": 5.0 },
      { "Display": "2GB Bundle (GHS 10)", "Value": "DATA10", "Amount": 10.0 },
      { "Display": "5GB Bundle (GHS 20)", "Value": "DATA20", "Amount": 20.0 },
      { "Display": "11GB Bundle (GHS 50)", "Value": "DATA50", "Amount": 50.0 }
  ]
}
```

### AT Data Bundle Top-Up

This endpoint is used to top up a AT account with a data bundle.

| | |
|---|---|
| API Endpoint | `https://cs.hubtel.com/commissionservices/{Disbursement_Account_Number}/06abd92da459428496967612463575ca` |
| Request Type | POST |
| Content Type | JSON |

**REQUEST PARAMETERS**

| Parameter | Type | Requirement | Description |
|---|---|---|---|
| Destination | String | Mandatory | The destination account to receive the data bundle value. |
| Amount | Float | Mandatory | The cost of the data bundle being purchased. This amount is known by querying for the available data bundles to purchase. |
| CallbackUrl | String | Mandatory | Used to receive the callback for the transaction from Hubtel. See below for a sample callback. |
| ClientReference | String | Mandatory | The reference number that is provided by the API user. |
| Extradata | Object | Mandatory | This Object contains bundle name/key. |
| Bundle | String | Mandatory | The desired bundle being purchased. This parameter is taken from the "value" response parameter on the MTN Data Bundle Query Endpoint. Note that: if the Bundle and the amount do not correspond to what is taken from the Data Bundle Query endpoint, the transaction will fail. |

**RESPONSE PARAMETERS**

| Parameter | Type | Description |
|---|---|---|
| ResponseCode | String | The unique response code on the status of the transaction. |
| Message | String | The description of the response received from the API call that is related to the ResponseCode. |
| ClientReference | String | The reference number that was initially provided by the API user in the request payload. |
| Amount | Float | The transaction amount, minus the charges/fees. |
| TransactionId | String | The unique ID to identify a transaction. |
| Commission | String | The commission gained for the transaction. |

**SAMPLE REQUEST**

```http
POST /commissionservices/11691/06abd92da459428496967612463575ca HTTP/1.1
Host: cs.hubtel.com
Accept: application/json
Content-Type: application/json
Authorization: Basic endjeOBiZHhza250fT3==

{
    "Destination": "233273833933",
    "Amount": 50,
    "CallbackUrl": "https://webhook.site/fcad8efa-624b-44c8-a129-b1c01921191d",
    "ClientReference": "TestDATA01090",
    "Extradata": {
        "bundle": "DATA50",
    }
}
```

**SAMPLE RESPONSE** — 200 OK

```json
{
  "ResponseCode": "0001",
  "Message": "Transaction pending. Expect callback request for final state",
  "Data": {
      "ClientReference": "TestDATA01090",
      "Amount": 50,
      "TransactionId": " 6bf810b8f7d5424a973165b36cc1817e",
      "Meta": {
          "Commission": "0.0560"
      }
  }
}
```

**SAMPLE CALLBACK**

```json
{
  "ResponseCode": "0000",
  "Data": {
      "AmountDebited": 50,
      "TransactionId": "d880a1a9cdb64e6b861f06b51b4f7504",
      "ClientReference": "TestDATA2024Ka",
      "Description": "Operation successful.",
      "ExternalTransactionId": "999000002777764224",
      "Amount": 50,
      "Charges": 0,
      "Meta": {
          "Commission": "0.0333"
      },
      "RecipientName": null
  }
}
```

> **Note:** Businesses that want to add an extra layer of security to ensure callbacks reach their endpoint securely can whitelist Hubtel's callback IP address: 18.202.122.131

---

## Utility Bill Payments

### DSTV Account Query

This queries the DSTV service to get the details of a DSTV account.

| | |
|---|---|
| API Endpoint | `https://cs.hubtel.com/commissionservices/{Disbursement_Account_Number}/297a96656b5846ad8b00d5d41b256ea7?destination={AccountNumber}` |
| Request Type | GET |
| Content Type | JSON |

**REQUEST PARAMETERS**

| Parameter | Type | Requirement | Description |
|---|---|---|---|
| Destination | String | Mandatory | The DSTV account number. |

**RESPONSE PARAMETERS**

| Parameter | Type | Description |
|---|---|---|
| ResponseCode | String | The unique response code on the status of the transaction. |
| Message | String | The description of the response received from the API call that is related to the ResponseCode. |
| Label | String | The response label from the service provider. Usually the same as the message. |
| Data | ArrayOfObjects | This is an Array of objects that contains info on the account. |
| Display | String | The display key for the account detail. Eg: name, account, etc. |
| Value | String | This shows the actual account detail of the "Display" parameter. Eg: the Account name (John Manu) is shown under a display key of value "name". |
| Amount | Float | The amount. This parameter is usually zero. |

**SAMPLE REQUEST**

```http
GET /commissionservices/11691/297a96656b5846ad8b00d5d41b256ea7?destination=7029864396 HTTP/1.1
Host: cs.hubtel.com
Accept: application/json
Content-Type: application/json
Authorization: Basic endjeOBiZHhza250fT3==
```

**SAMPLE RESPONSE** — 200 OK

```json
{
  "ResponseCode": "0000",
  "Message": "Successful",
  "Label": "",
  "Data": [
      { "Display": "name", "Value": "John Barnes", "Amount": 0.0 },
      { "Display": "amountDue", "Value": "0.00", "Amount": 0.0 },
      { "Display": "account", "Value": "7029864396", "Amount": 0.0 }
  ]
}
```

### DSTV Bill Payment

This endpoint is used to top up a DSTV account with any specified amount.

| | |
|---|---|
| API Endpoint | `https://cs.hubtel.com/commissionservices/{Disbursement_Account_Number}/297a96656b5846ad8b00d5d41b256ea7` |
| Request Type | POST |
| Content Type | JSON |

**REQUEST PARAMETERS**

| Parameter | Type | Requirement | Description |
|---|---|---|---|
| Destination | String | Mandatory | The DSTV account number. |
| Amount | Float | Mandatory | The top-up amount. NB: Only 2 decimal places is allowed E.g.: 0.50. |
| CallbackUrl | String | Mandatory | Used to receive the callback for the transaction from Hubtel. See below for a sample callback. |
| ClientReference | String | Mandatory | The reference number that is provided by the API user. |

**RESPONSE PARAMETERS**

| Parameter | Type | Description |
|---|---|---|
| ResponseCode | String | The unique response code on the status of the transaction. |
| Message | String | The description of the response received from the API call that is related to the ResponseCode. |
| ClientReference | String | The reference number that was initially provided by the API user in the request payload. |
| Amount | Float | The transaction amount, minus the charges/fees. |
| TransactionId | String | The unique ID to identify a transaction. |
| Meta | Object | Object that contains Commission key |
| Commission | String | The commission gained for the transaction. |

**SAMPLE REQUEST**

```http
POST /commissionservices/11691/297a96656b5846ad8b00d5d41b256ea7 HTTP/1.1
Host: cs.hubtel.com
Accept: application/json
Content-Type: application/json
Authorization: Basic endjeOBiZHhza250fT3==

{
    "Destination": "7029864396",
    "Amount": 50,
    "CallbackUrl": "https://webhook.site/fcad8efa-624b-44c8-a129-b1c01921191d",
    "ClientReference": "TestTV0101"
}
```

**SAMPLE RESPONSE** — 200 OK

```json
{
  "ResponseCode": "0001",
  "Message": "Transaction pending. Expect callback request for final state",
  "Data": {
      "ClientReference": "TestTV0101",
      "Amount": 50,
      "TransactionId": "9c6d65a2a7834759b44919a1621b80fd",
      "Meta": {
          "Commission": "0.3500"
      }
  }
}
```

**SAMPLE CALLBACK**

```json
{
  "ResponseCode": "0000",
  "Data": {
    "AmountDebited": 50,
    "TransactionId": "9c6d65a2a7834759b44919a1621b80fd",
    "ClientReference": "TestTV0101",
    "Description": "Status: DSTV[7038632593] Successful; Other Details: Approved or completed successfully; Reference: 09FG05151003161426526",
    "ExternalTransactionId": "09FG05151003161426526",
    "Amount": 50,
    "Charges": 0,
    "Meta": {
      "Commission": "0.35"
    },
    "RecipientName": null
  }
}
```

> **Note:** Businesses that want to add an extra layer of security to ensure callbacks reach their endpoint securely can whitelist Hubtel's callback IP address: 18.202.122.131

### GoTV Account Query

This queries the GoTV service to get the details of a DSTV account.

| | |
|---|---|
| API Endpoint | `https://cs.hubtel.com/commissionservices/{Disbursement_Account_Number}/e6ceac7f3880435cb30b048e9617eb41?destination={AccountNumber}` |
| Request Type | GET |
| Content Type | JSON |

**REQUEST PARAMETERS**

| Parameter | Type | Requirement | Description |
|---|---|---|---|
| Destination | String | Mandatory | The GoTV account number. |

**RESPONSE PARAMETERS**

| Parameter | Type | Description |
|---|---|---|
| ResponseCode | String | The unique response code on the status of the transaction. |
| Message | String | The description of the response received from the API call that is related to the ResponseCode. |
| Label | String | The response label from the service provider. Usually the same as the message. |
| Data | ArrayOfObjects | This is an Array of objects that contains info on the account. |
| Display | String | The display key for the account detail. Eg: name, account, etc. |
| Value | String | This shows the actual account detail of the "Display" parameter. Eg: the Account name (John Manu) is shown under a display key of value "name". |
| Amount | Float | The amount. This parameter is usually zero. |

**SAMPLE REQUEST**

```http
GET /commissionservices/11691/e6ceac7f3880435cb30b048e9617eb41?destination=7032371505 HTTP/1.1
Host: cs.hubtel.com
Accept: application/json
Content-Type: application/json
Authorization: Basic endjeOBiZHhza250fT3==
```

**SAMPLE RESPONSE** — 200 OK

```json
{
  "ResponseCode": "0000",
  "Message": "Successful",
  "Label": "",
  "Data": [
      { "Display": "name", "Value": "Senya Duku", "Amount": 0.0 },
      { "Display": "amountDue", "Value": "-201.00", "Amount": 0.0 },
      { "Display": "account", "Value": "7032371505", "Amount": 0.0 }
  ]
}
```

### GoTV Bill Payment

This endpoint is used to top up a GoTV account with any specified amount.

| | |
|---|---|
| API Endpoint | `https://cs.hubtel.com/commissionservices/{Disbursement_Account_Number}/e6ceac7f3880435cb30b048e9617eb41` |
| Request Type | POST |
| Content Type | JSON |

**REQUEST PARAMETERS**

| Parameter | Type | Requirement | Description |
|---|---|---|---|
| Destination | String | Mandatory | The GoTv account number. |
| Amount | Float | Mandatory | The top-up amount. NB: Only 2 decimal places is allowed E.g.: 0.50. |
| CallbackUrl | String | Mandatory | Used to receive the callback for the transaction from Hubtel. See below for a sample callback. |
| ClientReference | String | Mandatory | The reference number that is provided by the API user. |

**RESPONSE PARAMETERS**

| Parameter | Type | Description |
|---|---|---|
| ResponseCode | String | The unique response code on the status of the transaction. |
| Message | String | The description of the response received from the API call that is related to the ResponseCode. |
| ClientReference | String | The reference number that was initially provided by the API user in the request payload. |
| Amount | Float | The transaction amount, minus the charges/fees |
| TransactionId | String | The unique ID to identify a transaction. |
| Meta | Object | Object that contains Commission key |
| Commission | String | The commission gained for the transaction. |

**SAMPLE REQUEST**

```http
POST /commissionservices/11691/e6ceac7f3880435cb30b048e9617eb41 HTTP/1.1
Host: cs.hubtel.com
Accept: application/json
Content-Type: application/json
Authorization: Basic endjeOBiZHhza250fT3==

{
    "Destination": "7032371505",
    "Amount": 50,
    "CallbackUrl": "https://webhook.site/fcad8efa-624b-44c8-a129-b1c01921191d",
    "ClientReference": "TestTV0106",
}
```

**SAMPLE RESPONSE** — 200 OK

```json
{
  "ResponseCode": "0001",
  "Message": "Transaction pending. Expect callback request for final state",
  "Data": {
      "ClientReference": "TestTV0106",
      "Amount": 50.0,
      "TransactionId": "9c6d65a2a7834759b44919a1621b80fd",
      "Meta": {
          "Commission": "0.3500"
      }
  }
}
```

**SAMPLE CALLBACK**

```json
{
  "ResponseCode": "0000",
  "Data": {
    "AmountDebited": 50,
    "TransactionId": "f871040095cd46ca9389f1b447d80c5e",
    "ClientReference": "TestTV0106",
    "Description": "Status: DSTV[7032371505] Successful; Other Details: Approved or completed successfully; Reference: 09FG05151017535304132",
    "ExternalTransactionId": "09FG05151017535304132",
    "Amount": 50.0,
    "Charges": 0,
    "Meta": {
      "Commission": "0.3500"
    },
    "RecipientName": null
  }
}
```

> **Note:** Businesses that want to add an extra layer of security to ensure callbacks reach their endpoint securely can whitelist Hubtel's callback IP address: 18.202.122.131

### StarTimes TV Account Query

This queries the StarTimes TV service to get the details of a DSTV account.

| | |
|---|---|
| API Endpoint | `https://cs.hubtel.com/commissionservices/{Disbursement_Account_Number}/6598652d34ea4112949c93c079c501ce?destination={AccountNumber}` |
| Request Type | GET |
| Content Type | JSON |

**REQUEST PARAMETERS**

| Parameter | Type | Requirement | Description |
|---|---|---|---|
| Destination | String | Mandatory | The StarTimes TV account number. |

**RESPONSE PARAMETERS**

| Parameter | Type | Description |
|---|---|---|
| ResponseCode | String | The unique response code on the status of the transaction. |
| Message | String | The description of the response received from the API call that is related to the ResponseCode. |
| Label | String | The response label from the service provider. Usually the same as the message. |
| Data | ArrayOfObjects | This is an Array of objects that contains info on the account. |
| Display | String | The key that holds several details about the account. E.g.: name, account number and bouquet. |
| Value | String | This shows the actual account detail of the "Display" parameter. Eg: the Account name (John Nti) is shown under a display key of value "name". |
| Amount | Float | The amount being paid for in this transaction. As this is a Query endpoint and not a POST endpoint, this parameter will usually be empty. |

**SAMPLE REQUEST**

```http
GET /commissionservices/11691/6598652d34ea4112949c93c079c501ce?destination=02190617357 HTTP/1.1
Host: cs.hubtel.com
Accept: application/json
Content-Type: application/json
Authorization: Basic endjeOBiZHhza250fT3==
```

**SAMPLE RESPONSE** — 200 OK

```json
{
  "ResponseCode": "0000",
  "Message": "Successful",
  "Label": "Successful",
  "Data": [
      { "Display": "Name", "Value": "Joe Nti", "Amount": 0.0 },
      { "Display": "Account Number", "Value": "02190617357", "Amount": 0.0 },
      { "Display": "Bouquet", "Value": "DTH_Super ", "Amount": 0.0 }
  ]
}
```

### StarTimes TV Bill Payment

This endpoint is used to top up a StartTimes TV account with any specified amount.

| | |
|---|---|
| API Endpoint | `https://cs.hubtel.com/commissionservices/{Disbursement_Account_Number}/6598652d34ea4112949c93c079c501ce` |
| Request Type | POST |
| Content Type | JSON |

**REQUEST PARAMETERS**

| Parameter | Type | Requirement | Description |
|---|---|---|---|
| Destination | String | Mandatory | The StarTimes TV account number. |
| Amount | Float | Mandatory | The top-up amount. NB: Only 2 decimal places is allowed E.g.: 0.50. |
| CallbackUrl | String | Mandatory | Used to receive the callback for the transaction from Hubtel. See below for a sample callback. |
| ClientReference | String | Mandatory | The reference number that is provided by the API user. |

**RESPONSE PARAMETERS**

| Parameter | Type | Description |
|---|---|---|
| ResponseCode | String | The unique response code on the status of the transaction. |
| Message | String | The description of the response received from the API call that is related to the ResponseCode. |
| ClientReference | String | The reference number that was initially provided by the API user in the request payload. |
| Amount | Float | The transaction amount. NB: Only 2 decimal places is allowed E.g.: 0.50. |
| TransactionId | String | The unique ID to identify a transaction. |
| Meta | Object | Object that contains Commission key |
| Commission | String | The commission gained for the transaction. |

**SAMPLE REQUEST**

```http
POST /commissionservices/11691/6598652d34ea4112949c93c079c501ce HTTP/1.1
Host: cs.hubtel.com
Accept: application/json
Content-Type: application/json
Authorization: Basic endjeOBiZHhza250fT3==

{
    "Destination": "02190617357",
    "Amount": 50,
    "CallbackUrl": "https://webhook.site/fcad8efa-624b-44c8-a129-b1c01921191d",
    "ClientReference": "TestTV0108",
}
```

**SAMPLE RESPONSE** — 200 OK

```json
{
  "ResponseCode": "0001",
  "Message": "Transaction pending. Expect callback request for final state",
  "Data": {
      "ClientReference": "TestTV0108",
      "Amount": 50.0,
      "TransactionId": "0bf810b8f7d5424a973165b36cc1817e",
      "Meta": {
          "Commission": "0.3500"
      }
  }
}
```

**SAMPLE CALLBACK**

```json
{
  "ResponseCode": "0000",
  "Data": {
    "AmountDebited": 50,
    "TransactionId": "0bf810b8f7d5424a973165b36cc1817e",
    "ClientReference": "TestTV0108",
    "Description": "Payment made was Successfully",
    "ExternalTransactionId": "2000020594",
    "Amount": 50,
    "Charges": 0,
    "Meta": {
      "Commission": "0.3500"
    },
    "RecipientName": null
  }
}
```

> **Note:** Businesses that want to add an extra layer of security to ensure callbacks reach their endpoint securely can whitelist Hubtel's callback IP address: 18.202.122.131

### ECG Meter Query

This queries the list of Meters linked to a mobile number via the ECG Power App.

| | |
|---|---|
| API Endpoint | `https://cs.hubtel.com/commissionservices/{Disbursement_Account_Number}/e6d6bac062b5499cb1ece1ac3d742a84?destination={MobilePhone_Number}` |
| Request Type | GET |
| Content Type | JSON |

**REQUEST PARAMETERS**

| Parameter | Type | Requirement | Description |
|---|---|---|---|
| Destination | String | Mandatory | The mobile number linked to a particular ECG meter whose details need to be checked. |

**RESPONSE PARAMETERS**

| Parameter | Type | Description |
|---|---|---|
| ResponseCode | String | The unique response code on the status of the transaction. |
| Message | String | The description of the response received from the API call that is related to the ResponseCode. |
| Label | String | The response label from the service provider. Usually the same as the message. |
| Data | ArrayOfObjects | This is an Array of objects that contains info about the meter. |
| Display | String | The key that holds several details about the meter. Eg: name, account, etc. |
| Value | String | This shows the Meter Number. |
| Amount | Float | The outstanding amount to be paid on the meter. |

**SAMPLE REQUEST**

```http
GET /commissionservices/11691/e6d6bac062b5499cb1ece1ac3d742a84?destination=233541312238 HTTP/1.1
Host: cs.hubtel.com
Accept: application/json
Content-Type: application/json
Authorization: Basic endjeOBiZHhza250fT3==
```

**SAMPLE RESPONSE** — 200 OK

```json
{
  "ResponseCode": "0000",
  "Message": "Successful",
  "Label": "Successful",
  "Data": [
      { "Display": " THOMAS ANANE (G131099826)", "Value": " G131099826", "Amount": -1.1432 },
      { "Display": " ADEMAU LYDIA (24911947992)", "Value": " 24911947992", "Amount": 0 }
  ]
}
```

### ECG Meter Top-Up

This endpoint is used to top up a Meter (PostPaid or Prepaid).

| | |
|---|---|
| API Endpoint | `https://cs.hubtel.com/commissionservices/{Disbursement_Account_Number}/e6d6bac062b5499cb1ece1ac3d742a84` |
| Request Type | POST |
| Content Type | JSON |

**REQUEST PARAMETERS**

| Parameter | Type | Requirement | Description |
|---|---|---|---|
| Destination | String | Mandatory | The mobile phone number linked to a particular ECG Meter. |
| Amount | Float | Mandatory | The amount to be topped up on the meter. |
| CallbackUrl | String | Mandatory | Used to receive the callback for the transaction from Hubtel. See below for a sample callback. |
| ClientReference | String | Mandatory | The reference number that is provided by the API user. |
| Extradata | Object | Mandatory | This Object contains the bundle. |
| Bundle | String | Mandatory | This is the actual Meter Number or Account Number for which the Topup is to be done. |

> **Note:** This endpoint will link the phone number to the meter if that has not already been done. Please ensure that this is your intended action. For POSTPAID meters, pass the account number in the bundle parameter.

**RESPONSE PARAMETERS**

| Parameter | Type | Description |
|---|---|---|
| ResponseCode | String | The unique response code on the status of the transaction. |
| Message | String | The description of the response received from the API call that is related to the ResponseCode. |
| ClientReference | String | The reference number that was initially provided by the API user in the request payload. |
| Amount | Float | The transaction amount. |
| TransactionId | String | The unique ID to identify a transaction. |
| Meta | Object | Object that contains Commission key |
| Commission | String | The commission gained for the transaction. |

**SAMPLE REQUEST**

```http
POST /commissionservices/11691/e6d6bac062b5499cb1ece1ac3d742a84 HTTP/1.1
Host: cs.hubtel.com
Accept: application/json
Content-Type: application/json
Authorization: Basic endjeOBiZHhza250fT3==

{
    "Destination": "233541312238",
    "Amount": 1,
    "CallbackUrl": "https://webhook.site/fcad8efa-624b-44c8-a129-b1c01921191d",
    "ClientReference": "TestDATA2022052105",
    "Extradata": {
        "bundle": "P09137104"
    }
}
```

**SAMPLE RESPONSE** — 200 OK

```json
{
  "ResponseCode": "0001",
  "Message": "Transaction pending. Expect callback request for final state",
  "Data": {
      "ClientReference": " TestDATA2022052105",
      "Amount": 1,
      "TransactionId": " 6bf810b8f7d5424a973165b36cc1817e",
      "Meta": {
          "Commission": "0.0171"
      }
  }
}
```

**SAMPLE CALLBACK**

```json
{
  "ResponseCode": "0000",
  "Data": {
    "AmountDebited": 1,
    "TransactionId": "6bf810b8f7d5424a973165b36cc1817e",
    "ClientReference": "TestDATA2022052105",
    "Description": "success",
    "ExternalTransactionId": "7289775",
    "Amount": 1,
    "Charges": 0,
    "Meta": {
      "Commission": "0.0171"
    },
    "RecipientName": null
  }
}
```

> **Note:** Businesses that want to add an extra layer of security to ensure callbacks reach their endpoint securely can whitelist Hubtel's callback IP address: 18.202.122.131

### Ghana Water Meter Query

This queries the Ghana Water service to get the details of a Ghana Water Company Ltd account.

| | |
|---|---|
| API Endpoint | `https://cs.hubtel.com/commissionservices/{Disbursement_Account_Number}/6c1e8a82d2e84feeb8bfd6be2790d71d?destination={MeterNumber}&mobile={phoneNumber}` |
| Request Type | GET |
| Content Type | JSON |

**REQUEST PARAMETERS**

| Parameter | Type | Requirement | Description |
|---|---|---|---|
| Destination | String | Mandatory | The meter number to be queried. |
| mobile | String | Mandatory | The customer's phone number. |

**RESPONSE PARAMETERS**

| Parameter | Type | Description |
|---|---|---|
| ResponseCode | String | The unique response code on the status of the transaction. |
| Message | String | The description of the response code received from the response payload. |
| Label | String | The response label from the service provider. Usually the same as the message. |
| Data | ArrayOfObjects | This is an Array of objects that contains info on the account. |
| Display | String | The display key for the account detail. E.g.: name, amount, sessionID etc. Note: The sessionID is unique per request. |
| Value | String | This shows the actual account detail of the "Display" parameter. E.g.: the Account name (Amakye Frempong) is shown under a display key of value "name". |
| Amount | Float | The amount, this parameter is usually zero. |

**SAMPLE REQUEST**

```http
GET /commissionservices/11691/6c1e8a82d2e84feeb8bfd6be2790d71d?destination=091019010006&mobile=233242825109 HTTP/1.1
Host: cs.hubtel.com
Accept: application/json
Content-Type: application/json
Authorization: Basic endjeOBiZHhza250fT3==
```

**SAMPLE RESPONSE** — 200 OK

```json
{
  "ResponseCode": "0000",
  "Message": "Successful",
  "Label": "Successful",
  "Data": [
      { "Display": "name", "Value": "AMAKYE FREMPONG", "Amount": 0.0 },
      { "Display": "amountDue", "Value": "371.89", "Amount": 371.89 },
      { "Display": "sessionId", "Value": "3792660ccf0e687b64cdb3f776fd6e368ca4260d", "Amount": 0.0 }
  ]
}
```

### Ghana Water Meter Top-Up

This enables you to top-up your Ghana Water Company Ltd account.

| | |
|---|---|
| API Endpoint | `https://cs.hubtel.com/commissionservices/{Disbursement_Account_Number}/6c1e8a82d2e84feeb8bfd6be2790d71d` |
| Request Type | POST |
| Content Type | JSON |

**REQUEST PARAMETERS**

| Parameter | Type | Requirement | Description |
|---|---|---|---|
| Destination | String | Mandatory | The customer's phone number. |
| Amount | Float | Mandatory | This is the top-up amount. NB: Only 2 decimal places is allowed E.g.: 0.50. |
| ExtraData | Object | Mandatory | This Object contains the customer's phone number, customer's e-mail, and the session ID. |
| Bundle | String | Mandatory | This is the meter account number |
| E-mail | String | Mandatory | The customer's email address. |
| SessionID | String | Mandatory | Generated from meter query. This is unique per transaction. |
| CallbackUrl | String | Mandatory | Used to receive the callback for the transaction from Hubtel. See below for a sample callback. |
| ClientReference | String | Mandatory | The unique reference number that is provided by the API user. |

**RESPONSE PARAMETERS**

| Parameter | Type | Description |
|---|---|---|
| ResponseCode | String | The unique response code on the status of the transaction. |
| Message | String | The description of the response received from the API call that is related to the ResponseCode. |
| Data | Object | This is an Object that contain details of top-up initiated. |
| ClientReference | String | The reference number that was initially provided by the API user in the request payload. |
| Amount | Float | The transaction amount, minus the charges/fees. |
| TransactionId | String | The unique ID to identify a transaction. |
| Meta | Object | This object contains details of the commission charged. |
| Commission | String | The commission gained for the transaction. |

**SAMPLE REQUEST**

```http
POST /commissionservices/11691/6c1e8a82d2e84feeb8bfd6be2790d71d HTTP/1.1
Host: cs.hubtel.com
Accept: application/json
Content-Type: application/json
Authorization: Basic endjeOBiZHhza250fT3==

{
    "Destination": "233548359582",
    "Amount": 1,
    "Extradata": {
        "bundle": "080706070056",
        "Email": "username@example.com",
        "SessionId": "e7a113dd2f8b08b85a149d3db40854de2f13410b"
    },
    "CallbackUrl": "https://webhook.site/b630fc60-8041-470c-b13e-ee69ef15b2c2",
    "ClientReference": "275438fce23f4983b9583abdf0ded9c7e"
}
```

**SAMPLE RESPONSE** — 200 OK

```json
{
  "ResponseCode": "0001",
  "Message": "Transaction pending. Expect callback request for final state.",
  "Data": {
      "ClientReference": "509e21d2b1104036a64ca44b30613f1ftestt",
      "Amount": 1.0,
      "TransactionId": "7304f27f559a4680a912ce7ec19e6d2a",
      "Meta": {
          "Commission": "0.0070"
      }
  }
}
```

**SAMPLE CALLBACK**

```json
{
  "ResponseCode": "0000",
  "Data": {
    "AmountDebited": 1,
    "TransactionId": "7b4ada5714754d8bb8150712fd837ed9",
    "ClientReference": "509e21d2b1104036a64ca44b30613f1ftesttt",
    "Description": "Success",
    "ExternalTransactionId": "050a9435954148e1b4e3bd112a7bc4802cee8886",
    "Amount": 1,
    "Charges": 0,
    "Meta": {
      "Commission": "0.0007"
    },
    "RecipientName": null
  }
}
```

> **Note:** Businesses that want to add an extra layer of security to ensure callbacks reach their endpoint securely can whitelist Hubtel's callback IP address: 18.202.122.131

---

## Transaction Status Check

It is mandatory to implement the Transaction Status Check API as it allows merchants to check for the status of a receive money transaction in rare instances where a merchant does not receive the final status of the transaction after five (5) minutes from Hubtel.

To check a transaction status, send an HTTP GET request to the below URL with either one or more unique transaction identifiers as parameters.

**It is also mandatory to parse your Collection Account Number for Status Check requests in the endpoint.** Find your Collection Account Number here. *(link not captured)*

> **Note:** Only requests from whitelisted IP(s) can reach the endpoint. Submit your public IP(s) to your Retail Systems Engineer to be whitelisted.
>
> We permit a maximum of 4 IP addresses per service.

| | |
|---|---|
| API Endpoint | `https://api-txnstatus.hubtel.com/transactions/{Collection_Account_Number}/status` |
| Request Type | GET |
| Content Type | JSON |

**REQUEST PARAMETERS**

| Parameter | Type | Requirement | Description |
|---|---|---|---|
| clientReference | String | Mandatory (preferred) | The clientReference of the transaction specified in the request payload. |
| hubtelTransactionId | String | Optional | TransactionId from Hubtel after successful receive money request. |
| networkTransactionId | String | Optional | The transaction reference from the mobile money provider. |

> **Note:** Although either one of the unique transaction identifiers above could be passed as parameters, clientReference is recommended to be used often.

**SAMPLE REQUEST**

```http
GET /transactions/11684/status?clientReference=TestAirt HTTP/1.1
Host: api-txnstatus.hubtel.com
Authorization: Basic endjeOBiZHhza250fT3==
```

**RESPONSE PARAMETERS**

| Parameter | Type | Description |
|---|---|---|
| message | String | The description of response received from the Commission Services API that is related to the ResponseCode. |
| responseCode | String | The response code of the API after the request. |
| data | Object | An object containing the required data response from the Commission Services API. |
| date | String | Date of the transaction |
| status | String | Status of the transaction i.e.: Paid or Unpaid |
| transactionId | String | The unique ID used to identify a Hubtel transaction (from Hubtel). |
| externalTransactionId | String | The transaction reference from the mobile money provider (from Telco). |
| paymentMethod | String | The mode of payment |
| clientReference | String | The reference ID that is initially provided by the client/API user in the request payload. (from merchant) |
| currencycode | String | Currency of the transaction; could be null |
| amount | Float | The transaction amount. |
| charges | Float | The charge/fee for the transaction. |
| amountAfterCharges | Float | The transaction amount after charges/fees deduction. |
| isFulfilled | Boolean | Whether service was fulfilled; could be null |

**SAMPLE RESPONSE (Success)** — 200 OK

```json
{
  "message": "Successful",
  "responseCode": "0000",
  "data": {
      "date": "2024-01-15T21:28:17.3234841Z",
      "status": "Paid",
      "transactionId": "9a7304855d8a4041917509bb46be7050",
      "externalTransactionId": null,
      "paymentMethod": "cash",
      "clientReference": "TestAirt",
      "currencyCode": null,
      "amount": 1.0,
      "charges": 0.0,
      "amountAfterCharges": 1.0,
      "isFulfilled": true
  }
}
```

**SAMPLE RESPONSE (Failed)** — 200 OK *(the docs' sample has an extra pair of outer braces — a typo)*

```json
{
    "message": "Successful",
    "responseCode": "0000",
    "data": {
        "date": "2024-01-15T21:58:21.1918103Z",
        "status": "Unpaid",
        "transactionId": "f35e5ec1ee984c4b85b310ad969db776",
        "externalTransactionId": null,
        "paymentMethod": "cash",
        "clientReference": "testECGr",
        "currencyCode": null,
        "amount": 1.0,
        "charges": 0.0,
        "amountAfterCharges": 1.0,
        "isFulfilled": false
    }
}
```

---

## Response Codes

The Hubtel Commission Services API uses standard HTTP error reporting. Successful requests return HTTP status codes in the 2xx. Failed requests return status codes in 4xx and 5xx.

Error responses are included in the JSON response body, which contains information about the error. You can also find Error Responses in the Final Callbacks.

> **Note:** Response Codes which are not 0000 should be considered as FAILED.

| Response Code | Description | Required Action |
|---|---|---|
| 0000 | The transaction has been processed successfully. | None |
| 0001 | Transaction pending. Expect callback request for final state | None |
| 0005 | There was an HTTP failure/exception. | The transaction state is not known. Please contact your Retail Systems Engineer to confirm the status of this transaction. |
| 2000 | General Failure Error | |
| 2001 | General Failure Error | Usually, check the description of the response callback. It gives the actual error. Eg: The receiving user is not registered in the system. Or the Bundle is invalid |
| 4000 | An error occured. Kindly try again later/ missing mobile value. An error occured during verification | Kindly check to ensure you are parsing the correct parameters. |
| 4010 | Validation Errors | A required request parameter might have been left empty, invalid or omitted. |
| 4101 | Authorization for request is denied/could not find prepaid account | Ensure that you're providing the correct Basic Auth key for the Authorization header. Also ensure you're passing your Disbursement Account Number in the endpoint |
| 4103 | Permission denied | You are not allowed to perform this transaction. Kindly ensure your API keys are accurate. |
| 4075 | Insufficient prepaid balance. | You don't have enough funds in your Disbursement Account to render this service to your customers. You can top-up your Disbursement Account by transferring funds from your available balance or bank deposit. |

> **Telecel Postpaid Bills** (ServiceID `a3ab78c84c6b4976b78a6f393e247a72`) is listed in the ServiceIDs table but has **no endpoint section** in the docs.

---

## Implementation notes derived from this text (Datagod, 2026-10-13)

- **Disbursement Account Number is mandatory in the URL of every request** (query and POST). Our client builds
  `https://cs.hubtel.com/commissionservices/{HUBTEL_DISBURSEMENT_ACCOUNT}/{serviceId}` — so in direct mode
  `HUBTEL_DISBURSEMENT_ACCOUNT` must be set in Vercel; in relay mode the relay's own env supplies it.
- **No category field in bundle query responses.** Each item is only `{Display, Value, Amount}`.
  - MTN: category is implied by `Value` prefix — `data_bundle_*`, `kokrokoo_bundle_*`, `flexi_data_bundle`,
    `video_bundle_*`, `social_media_bundle_*` (and `Display` text prefixes "Kokrokoo", "Video", "Social Media").
    `flexi_data_bundle` repeats with different Amounts → a bundle's identity is **Value + Amount**.
  - Telecel: `Display` is a plan name ("Dual Recharge", "Chat Monthly", "Starter Monthly", "Streamer Weekly",
    "Browser Daily", "Starter Daily") — period/type implied by the name; `Value` is a size string with occasional
    leading spaces (" 5.7 GB") that must be sent exactly as returned.
  - AT: single family (`DATA1…DATA50`), `Display` like "2GB Bundle (GHS 10)"; `Label` is "Select bundle".
- The docs say the query returns bundles "which can be purchased for a specific number" and that packages "are subject to
  change by the telco" — not whether lists differ between numbers on the same network. Unverified until two live
  queries are compared.
- `TransactionId` can carry a leading space (" 558625e7…", " 6bf810b8…") — trim (Phase 1 already does).
- POST response `Amount` is "the transaction amount, minus the charges/fees" and can differ from the requested amount
  (airtime samples request 0.5 and return 0.85) — never use it as the amount we charged.
- Bill query `Display` keys are inconsistent: DSTV/GOtv/Broadband use `name` / `amountDue` / `account`; StarTimes uses
  `Name` / `Account Number` / `Bouquet` → parse case-insensitively and by fuzzy key. GOtv `amountDue` can be negative
  ("-201.00"); ECG `Amount` can be negative (-1.1432) and ECG `Display`/`Value` carry leading spaces.
- **ECG POST links the phone number to the meter if not already linked** — the UI must make this explicit to the customer.
  For POSTPAID, the account number goes in `Extradata.bundle`.
- Telecel Broadband sample commission is "0.0000" — commission can be zero for some services.
- Some sample bodies contain trailing commas (invalid JSON) — doc typos; ignore.
- **Ghana Water:** query needs `destination=<meter>` AND `mobile=<phone>`; it returns a `sessionId` that is unique per query
  and must be sent in the POST as `Extradata.SessionId` (with `Extradata.bundle` = meter no, `Extradata.Email` mandatory).
  POST `Destination` is the customer's PHONE, not the meter. The parameter table spells them `ExtraData`/`E-mail`/`SessionID`
  but the sample uses `Extradata`/`Email`/`SessionId` — Phase 1's client uses the sample's spelling. The query's
  `amountDue` carries the value in both `Value` (string) and `Amount` (number).
- **ECG POST response echoes `ClientReference` with a leading space** (" TestDATA2022052105") — always match on the
  trimmed value; never compare raw.
- **Status Check** uses the **Collection** account number (not Disbursement), only from whitelisted IPs (max 4 per service).
  `status` is "Paid"/"Unpaid"; failed sample = Unpaid + `isFulfilled:false`; success = Paid + `isFulfilled:true`.
  Prefer `clientReference` as the lookup key.
- **Response codes:** "codes which are not 0000 should be considered as FAILED" (0001 = pending is the exception in
  practice); `0005` = state unknown → contact Retail Systems Engineer, never assume failed; `4101` can mean a missing or
  wrong Disbursement Account Number in the URL.
