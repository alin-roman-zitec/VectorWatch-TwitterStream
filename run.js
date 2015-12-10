var Promise = require('bluebird');
var Twitter = require('twitter');

var updateIntervalInMinutes = 15;

var configJSON = {
    streamUID: process.env.STREAM_UID,
    token: process.env.VECTOR_TOKEN,

    auth: {
        protocol: 'oauth',
        version: '1.0',
        requestTokenUrl: 'https://api.twitter.com/oauth/request_token',
        accessTokenUrl: 'https://api.twitter.com/oauth/access_token',
        authorizeUrl: 'https://api.twitter.com/oauth/authorize',
        callbackUrl: 'http://vectorwatch-srv.cloudapp.net:3025/callback',
        consumerKey: process.env.TWITTER_KEY,
        consumerSecret: process.env.TWITTER_SECRET
    },

    database: {
        host: 'localhost',
        user: 'root',
        password: '',
        database: 'TwitterStream'
    }
};
var vectorWatch = require('stream-dev-tools');
var vectorStream = vectorWatch.createStreamNode(configJSON);

var TwitterApi = require('./TwitterApi.js');
var twitterApi = new TwitterApi();

var getTwitterClientForTokens = function(authTokens) {
    return Promise.resolve(new Twitter({
        consumer_key: configJSON.auth.consumerKey,
        consumer_secret: configJSON.auth.consumerSecret,
        access_token_key: authTokens.oauth_access_token,
        access_token_secret: authTokens.oauth_access_token_secret
    }));
};

var getAuthTokensForState = function(state) {
    var future = Promise.defer();

    vectorStream.getAuthTokensForState(state, function(err, authTokens) {
        if (err) return future.reject(err);
        future.resolve(authTokens);
    });

    return future.promise;
};

var getTwitterClientForState = function(state, authTokens) {
    if (authTokens instanceof Twitter) {
        return Promise.resolve(authTokens);
    }

    var authTokensPromise;
    if (authTokens) {
        authTokensPromise = Promise.resolve(authTokens);
    } else {
        authTokensPromise = getAuthTokensForState(state);
    }

    return authTokensPromise.then(getTwitterClientForTokens);
};

var getStreamDataForState = function(state, authTokens) {
    var from = state['Display From'];
    var option = state['Display Option'];
    return getTwitterClientForState(state, authTokens).then(function(twitterClient) {
        if (from == 'LAST_TWEET') {
            return twitterApi.getCountsForMyLastTweet(twitterClient).then(function(counts) {
                return 'R ' + counts.retweets + ', F ' + counts.favorites;
            });
        } else if (from == 'MY_PROFILE') {
            return twitterApi.getMyFollowersCount(twitterClient).then(function(followers) {
                return 'F ' + followers;
            });
        } else if (from == 'TRENDS') {
            return twitterApi.getTrendsForPlace(1, twitterClient).then(function(trends) {
                return (trends || []).slice(0, 3).join('\n') || 'N/A';
            });
        } else {
            return 'N/A';
        }
    });
};

var UserStreamsById = { };
var UserIdByChannelLabel = { };
var ChannelLabelsByUserId = { };

var getUserIdByState = function(state, authTokens) {
    if (UserIdByChannelLabel[state.channelLabel]) {
        return Promise.resolve(UserIdByChannelLabel[state.channelLabel]);
    }

    return getTwitterClientForState(state, authTokens).then(function(twitterClient) {
        return twitterApi.getUserId(twitterClient);
    });
};

var registerStreamByState = function(state, authTokens) {
    return getTwitterClientForState(state, authTokens).then(function (twitterClient) {
        return getUserIdByState(state, twitterClient).then(function (userId) {
            if (!ChannelLabelsByUserId[userId]) {
                ChannelLabelsByUserId[userId] = [state.channelLabel];
            } else {
                ChannelLabelsByUserId[userId].push(state.channelLabel);
                ChannelLabelsByUserId[userId] = ChannelLabelsByUserId[userId].filter(function(value, index, self) {
                    return self.indexOf(value) === index;
                });
            }

            if (UserStreamsById[userId]) {
                return UserStreamsById[userId];
            }

            var future = Promise.defer();

            twitterClient.stream('user', { }, function(stream) {
                UserStreamsById[userId] = stream;
                future.resolve(stream);
            });

            return future.promise.then(function(stream) {
                stream.on('data', function(data) {
                    handleUserPush(userId, twitterClient, data);
                });

                stream.on('error', function(err) {
                    console.error(err.stack || err);
                });

                stream.on('end', function() {
                    // retry connection here
                    delete UserStreamsById[userId];

                    Promise.delay(5000).then(function() {
                        if (!UserIdByChannelLabel[state.channelLabel]) {
                            return null;
                        }

                        return registerStreamByState(state, twitterClient);
                    }).then(function(stream) {
                        // do nothing here
                    }).catch(function(err) {
                        console.error(err.stack || err);
                    });
                });
            });
        });
    });
};

var unregisterStreamByState = function(state, authTokens) {
    return getTwitterClientForState(state, authTokens).then(function(twitterClient) {
        return getUserIdByState(state, twitterClient);
    }).then(function(userId) {
        if (!UserStreamsById[userId]) {
            return true;
        }

        delete UserIdByChannelLabel[state.channelLabel];
        ChannelLabelsByUserId[userId] = (ChannelLabelsByUserId[userId] || []).filter(function(value) {
            return value != state.channelLabel;
        });
        if (!ChannelLabelsByUserId[userId].length) {
            UserStreamsById[userId].destroy();

            delete ChannelLabelsByUserId[userId];
            delete UserStreamsById[userId];

            return true;
        }
    });
};

vectorStream.registerSettings = function(resolve, reject, settings, authTokens) {
    getTwitterClientForState(settings, authTokens).then(function(twitterClient) {
        registerStreamByState(settings, twitterClient).then(function(stream) {
            // do nothing here
        }).catch(function(err) {
            console.error(err.stack || err);
        });

        getStreamDataForState(settings, twitterClient).then(function(value) {
            resolve(value);
        }).catch(function(err) {
            reject(err);
        });
    }).catch(function(err) {
        reject(err);
    });
};

vectorStream.unregisterSettings = function(settings, authTokens) {
    unregisterStreamByState(settings, authTokens).then(function(success) {
        // do nothing
    }).catch(function(err) {
        console.error(err.stack || err);
    });
};

vectorStream.requestConfig = function(resolve) {
    resolve({
        renderOptions: {
            'Display From': {
                type: 'GRID_LAYOUT',
                hint: 'Select the option you want to display information from.',
                order: 0,
                dataType: 'STATIC'
            }//,
            //'Display Option': {
            //    type: 'GRID_LAYOUT',
            //    hint: 'Select the information you want to display.',
            //    order: 1,
            //    dataType: 'DYNAMIC',
            //    asYouType: false,
            //    minChars: 0
            //}
        },
        defaults: {
            'Display From': {
                value: 'LAST_TWEET'
            }//,
            //'Display Option': {
            //    value: 'RETWEETS'
            //}
        },
        settings: {
            'Display From': [
                { name: 'My Last Tweet', value: 'LAST_TWEET' },
                { name: 'My Profile', value: 'MY_PROFILE' },
                { name: 'Top 3 Trends', value: 'TRENDS' }//,
                //{ name: 'Notifications Today', value: 'NOTIFICATIONS' },
                //{ name: 'Messages Today', value: 'MESSAGES' }
            ]
        }
    });
};

//vectorStream.requestOptions = function(resolve, reject, settingName, searchTerm, state) {
//    if (settingName != 'Display Option') {
//        return reject(new Error('Invalid settingName supplied.'));
//    }
//
//    var from = state['Display From'];
//    if (from == 'LAST_TWEET') {
//        resolve([]);
//    } else if (from == 'MY_PROFILE') {
//        resolve([]);
//    } else {
//        reject(new Error('Invalid Display From setting.'));
//    }
//};

var handleUserPush = function(userId, twitterClient) {
    ChannelLabelsByUserId[userId].forEach(function(channelLabel) {
        vectorStream.stateStorage.retrieve(channelLabel, function(err, state) {
            if (err) return console.error(err.stack || err);

            getStreamDataForState(state, twitterClient).then(function(value) {
                vectorStream.push(state, value, 0.1);
            }).catch(function(err) {
                console.error(err.stack || err);
            });
        });
    });
};

setInterval(function() {
    vectorStream.retrieveSettings(function(states) {
        for (var channelLabel in states) {
            (function(state) {
                getStreamDataForState(state).then(function(value) {
                    vectorStream.push(state, value, 0.1);
                }).catch(function(err) {
                    console.error('Could not get stream data for state.', err.stack || err);
                });
            })(states[channelLabel]);
        }
    }, function(err) {
        console.error('Could not fetch settings from database.', err.stack || err);
    });
}, updateIntervalInMinutes * 60 * 1000);


vectorStream.startStreamServer(3025, function() {
    console.log('Built-in server started, listening on port 3025.');
});