var { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");
var axios = require("axios");
var rateLimit = require("axios-rate-limit");
var rax = require("retry-axios");
var axiosBH = rateLimit(axios.create(), {
    // Max calls per minute is 1500. So we need to rate limit.
    // For things that need to display quickly and don't make a ton of calls, better to use maxRequests/perMilliSeconds. For lots of requests over a prolonged period, it's better to use maxRPS by itself.
    // Do not use all three together.
    maxRequests: 1500,
    perMilliseconds: 60000,
    // maxRPS: 4,
});
// var dayjs = require("dayjs");
// var ULID = require("ulid");
var Eta = require("eta");
var path = require("path");

//
// Config
//

// Setup duration timing
axiosBH.interceptors.request.use(
    function (config) {
        config.metadata = { startTime: new Date() };
        return config;
    },
    function (error) {
        return Promise.reject(error);
    }
);

axiosBH.interceptors.response.use(
    function (response) {
        response.config.metadata.endTime = new Date();
        response.duration = response.config.metadata.endTime - response.config.metadata.startTime;
        return response;
    },
    function (error) {
        error.config.metadata.endTime = new Date();
        error.duration = error.config.metadata.endTime - error.config.metadata.startTime;
        return Promise.reject(error);
    }
);

// Setup retry for this instance
axiosBH.defaults.raxConfig = {
    instance: axiosBH,
    statusCodesToRetry: [
        [100, 199],
        [429, 429],
        [500, 599],
    ],
    retry: 2,
    noResponseRetries: 2,
    backoffType: "exponential", // 'exponential' (default), 'static' or 'linear'
    onRetryAttempt: (err) => {
        const cfg = rax.getConfig(err);
        // container.errors.push(`Retry attempt #${cfg.currentRetryAttempt}: ${err}`)
        console.log(`Retry attempt #${cfg.currentRetryAttempt}: ${err}`);
    },
};
const interceptorId = rax.attach(axiosBH);

// Set Eta's configuration
Eta.configure({
    // This tells Eta where to look for templates
    views: path.join(__dirname, "./"),
});

//
// Handler
//
exports.handler = async (event, context, callback) => {
    var container = {
        // startDateTime: dayjs().format('[YYYYescape] YYYY-MM-DDTHH:mm:ssZ[Z]'),
        CorporationID: "11604",
        templateToUse: "template.html",
        event: event,
        context: context,
        duration: new Date(),
        messages: {
            handler: [],
        },
        messagesAry: [],
        updateData: [],
        html: "<html><body>OK</body></html>",
    };

    // Start execution
    try {
        // Run Lambda for bhAuth
        container.messagesAry.push(await runBhAuth(container));

        // Get some general Bullhorn info (used to test that the login is working)
        container.messagesAry.push(await getBhInfo(container));

        // Run search
        container.messagesAry.push(await runSearch(container));

        // Render HTML
        let html = await Eta.renderFile("template.eta", container.searchData);

        // Return the HTML
        callback(null, {
            statusCode: 200,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Content-Type": "text/html",
            },
            body: html,
        });
    } catch (err) {
        console.log("err", err);

        // Mark this as an error
        container.messages.error = err;
    } finally {
        // Log the duration
        container.duration = new Date() - container.duration;

        // Clean up
        delete container.bh_auth;
        console.log(`${container.CorporationID}-container`, JSON.stringify(container, null, 4));
    }
};

//
// Functions
//
function runBhAuth(container) {
    return new Promise(function (resolve, reject) {
        let message = {
            functionName: "runBhAuth",
            status: "starting",
            duration: new Date(),
        };

        let lambdaParams = {
            FunctionName: "bullhornAuthBeta",
            Payload: {
                client_name: container.CorporationID,
                callingFunction: container.context.functionName,
                logStreamName: container.context.logStreamName,
            },
        };
        console.log(lambdaParams);

        // If we've been passed an authCode, use the authCode.
        // ** This is for the template only. Typically we would choose to use the authCode or NOT use the authCode
        if (container.event?.queryStringParameters?.authCode) {
            lambdaParams.Payload.authCode = container.event.queryStringParameters.authCode;

            // If the integration CorpId is different than the corpId, pass that here.
            // lambdaParams.Payload.integrationCorpID: "14121",  // Optional
        }

        // Stringify the Payload
        lambdaParams.Payload = JSON.stringify(lambdaParams.Payload);

        const client = new LambdaClient();
        const command = new InvokeCommand(lambdaParams);
        client.send(command).then(
            (data) => {
                console.log(data);

                // Convert payload from uint8array to string
                var string = new TextDecoder().decode(data.Payload);
                container.bh_auth = JSON.parse(string);

                // Return error if we don't have a rest token
                if (!container.bh_auth?.rest_token) {
                    message.status = "failure";

                    return reject(new Error("No REST token"));
                }
                // Mark Success
                message.status = data.$metadata.httpStatusCode;
                message.requestId = data.$metadata.requestId;
                message.attempts = data.$metadata.attempts;
                message.duration = new Date() - message.duration;

                // Setup axiosBH defaults
                axiosBH.defaults.baseURL = container.bh_auth.rest_url;
                axiosBH.defaults.headers["cache-control"] = "no-cache";
                axiosBH.defaults.headers["Content-Type"] = "application/json";
                axiosBH.defaults.headers.BhRestToken = container.bh_auth.rest_token;
                axiosBH.defaults.timeout = 10000;

                // Return to Handler
                return resolve(message);
            },
            (error) => {
                // error handling.
                console.log(error);

                // Return to Handler
                return reject(error);
            }
        );
    });
}

function getBhInfo(container) {
    return new Promise(function (resolve, reject) {
        let message = {
            functionName: "getBhInfo",
            status: "starting",
            duration: new Date(),
        };

        let config = {
            method: "get",
            url: "/settings/corporationId,corporationName,userId,bboName,deptId,allPrivateLabelIds,userTypeId,privateLabelId,userDepartments",
        };
        message.url = config.url;

        axiosBH(config)
            .then((response) => {
                container.bhInfo = response.data;

                // Mark success
                let fullResponse = axiosLogging(response, null);
                message.status = fullResponse.status;
                message.statusText = fullResponse.statusText;
                message.AxiosDuration = fullResponse.duration;
                message.duration = new Date() - message.duration;

                // Return to Handler
                resolve(message);
            })
            .catch((error) => {
                console.error(error.response);
                message.status = "error";
                message.error = error.response;

                // Return to Handler, with error
                reject(error);
            });
    });
}

function runSearch(container) {
    return new Promise(function (resolve, reject) {
        let message = {
            functionName: "runSearch",
            status: "starting",
            duration: new Date(),
        };

        let config = {
            method: "get",
            url: "/search/Candidate?fields=id,name,dateAdded,customText40&count=50&sort=id&query=id:[* TO *]",
        };

        axiosBH(config)
            .then((response) => {
                container.searchData = response.data;

                // Log the results
                message.total = response.data.total;
                message.count = response.data.count;

                // Mark success
                let fullResponse = axiosLogging(response, null);
                message.status = fullResponse.status;
                message.statusText = fullResponse.statusText;
                message.AxiosDuration = fullResponse.duration;
                message.duration = new Date() - message.duration;

                // Return to handler
                return resolve(message);
            })
            .catch(function (error) {
                // Handle error
                console.error(axiosLogging(null, error).string);

                // Mark this as an error and return to handler
                message.status = "error";
                message.errorMessage = axiosLogging(null, error).obj;

                // Return to Handler, with error
                reject(error);
            });
    });
}

function runLoopUpdate(container) {
    return new Promise(function (resolve, reject) {
        let message = {
            functionName: "runLoopUpdate",
            status: "starting",
            duration: new Date(),
        };
        // This assumes there is an array in container that holds data we need to loop through to run updates
        // Purposely set to customText1000 so it won't work until you set it properly

        // Setup array to hold promises
        var tmp = [];

        // Loop through updates to be run
        for (let update of container.updateData) {
            // Add the promise
            tmp.push(
                new Promise(function (resolve, reject) {
                    let data = JSON.stringify({ customText1000: update.userName });
                    let config = {
                        method: "post",
                        url: `/entity/Candidate/${update.candidateID}`,
                        data: data,
                    };

                    axiosBH(config)
                        .then((response) => {
                            // Setup return value
                            return resolve(`${update.candidateID}-${update.userName}: ${response.statusText}`);
                        })
                        .catch((error) => {
                            console.error(error.response);
                            return reject(new Error(error.statusCode));
                        });
                })
            );
        }

        // Wait for all promises to complete
        Promise.all(tmp)
            .then((values) => {
                // Put our return values into the container for troubleshooting and logging purposes
                container.returnValue = values;

                message.status = "success";
                message.duration = new Date() - message.duration;

                // Return to Handler
                return resolve(message);
            })
            .catch(function () {
                message.status = "error";

                // Stop everything and surface the error
                // Return to Handler, with error
                return reject();
            });
    });
}

function emptyFunction(container) {
    return new Promise(function (resolve, reject) {
        let message = {
            functionName: "emptyFunction",
            status: "starting",
            duration: new Date(),
        };

        message.status = "success";
        message.duration = new Date() - message.duration;
        return resolve(message);
    });
}

//
// Helper Functions
//
function axiosLogging(response, error) {
    if (response) {
        let responseObj = {
            status: response.status,
            statusText: response.statusText,
            duration: response.duration,
            headers: {
                "x-ratelimit-limit-minute": response.headers["x-ratelimit-limit-minute"],
                "x-ratelimit-remaining-minute": response.headers["x-ratelimit-remaining-minute"],
            },
            config: {
                url: response.config.url,
                method: response.config.method,
                headers: response.headers,
                data: response.config,
            },
            data: response.data,
        };

        return responseObj;
    }

    if (error) {
        if (error.response) {
            // The request was made and the server responded with a status code that falls out of the range of 2xx
            error = {
                data: error.response.data,
                status: error.response.status,
                duration: error.duration,
                headers: {
                    "x-ratelimit-limit-minute": error.response.headers["x-ratelimit-limit-minute"],
                    "x-ratelimit-remaining-minute": error.response.headers["x-ratelimit-remaining-minute"],
                },
            };
        } else if (error.request) {
            // The request was made but no response was received `error.request` is an instance of XMLHttpRequest in the browser and an instance of http.ClientRequest in node.js
            error = error.request;
        } else {
            // Something happened in setting up the request that triggered an Error
            error = error.message;
        }

        return error;
    }
}

// Will only show decimals if it's not a whole number
function round(value, isMoney) {
    // If the value is empty or undefined, return empty
    if (value === "" || value === undefined) return "";
    if (isFinite(value) === false) return -1;

    // Round the value
    value = Math.round(value * 100) / 100;

    // If the value is a whole number, don't show decimals
    if (value % 1 !== 0) value = value.toFixed(2);

    if (isMoney) value = "$" + value;

    return value;
}
