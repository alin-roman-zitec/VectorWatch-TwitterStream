var Promise = require('bluebird');

var TwitterApi = function TwitterApi() {
    this.caching = {};
};

TwitterApi.prototype.get = function(endpoint, args, twitterClient) {
    var future = Promise.defer();

    endpoint = endpoint.match(/^\/?(.*?)(\.json)?$/)[1];
    twitterClient.get(endpoint, args, function(err, data) {
        if (err) return future.reject(err);
        future.resolve(data);
    });

    return future.promise;
};

TwitterApi.prototype.getCached = function(endpoint, args, twitterClient, ttl) {
    var now = Date.now(),
        key = endpoint + JSON.stringify(args),
        _this = this;

    for (var k in this.caching) {
        if (this.caching[k].expire < now) {
            delete this.caching[k];
        }
    }

    if (this.caching[key]) {
        var cached = this.caching[key];
        if (cached.promise) {
            return cached.promise;
        }
        return Promise.resolve(cached.value);
    }

    this.caching[key] = {
        promise: this.get(endpoint, args, twitterClient).then(function(data) {
            delete _this.caching[key].promise;
            _this.caching[key].value = data;
            setTimeout(function() {
                delete _this.caching[key];
            }, ttl);
            return data;
        }).catch(function(err) {
            delete _this.caching[key];
            return Promise.reject(err);
        }),
        expire: now + ttl
    };

    return this.caching[key].promise;
};

TwitterApi.prototype.getCountsForMyLastTweet = function(twitterClient) {
    return this.get('statuses/user_timeline', {
        count: 1,
        include_rts: false,
        trim_user: true,
        exclude_replies: true
    }, twitterClient).then(function(tweets) {
        var counts = {
            retweets: 0,
            favorites: 0
        };
        if (tweets && tweets[0]) {
            counts.retweets = Number(tweets[0].retweet_count) || 0;
            counts.favorites = Number(tweets[0].favorite_count) || 0;
        }
        return counts;
    });
};

TwitterApi.prototype.getMyFollowersCount = function(twitterClient) {
    return this.get('account/verify_credentials', {
        include_entities: false,
        skip_status: true,
        include_email: false
    }, twitterClient).then(function(user) {
        if (user && user.followers_count) {
            return Number(user.followers_count) || 0;
        }
        return 0;
    });
};

TwitterApi.prototype.getUserId = function(twitterClient) {
    return this.get('account/verify_credentials', {
        include_entities: false,
        skip_status: true,
        include_email: false
    }, twitterClient).then(function(user) {
        return user && user.id_str;
    });
};

TwitterApi.prototype.getTrendsForPlace = function(woeId, twitterClient) {
    return this.getCached('trends/place', {
        id: woeId
    }, twitterClient, 60 * 1000).then(function(result) {
        return ((result && result[0] && result[0].trends) || []).map(function(trend) {
            return trend.name;
        });
    });
};

module.exports = TwitterApi;