function errorResponse(req, message, extras) {
    return {
        error: message,
        requestId: req?.requestId || null,
        ...(extras || {})
    };
}

function sendError(req, res, status, message, extras) {
    return res.status(status).json(errorResponse(req, message, extras));
}

module.exports = {
    errorResponse,
    sendError
};

