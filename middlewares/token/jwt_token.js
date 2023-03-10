const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const express = require('express')
const router = express.Router()
const jwt = require('jsonwebtoken')
const config = require('@config/index')
const authConfig = require('@config/settings/auth')
const { createResponse } = require('@helpers/handlers/response')

const NODE_ENV = config.NODE_ENV

// to verify jwt for method 2 (asymmetric)
const publicKey = fs.readFileSync(
    path.join(__dirname, '../../config/rsa-ssh/public.key'),
    { encoding: 'utf-8' }
)

// to sign jwt for method 2 (asymmetric)
const privateKey = fs.readFileSync(
    path.join(__dirname, '../../config/rsa-ssh/private.key'),
    { encoding: 'utf-8' }
)

// to check menu permissions
const sumPermission = (role) => {
    return authConfig.userRoleAccess[role]
        .split(',')
        .reduce((sum, cur) => +sum + +cur, 0)
}

// local response methods
const authorized = (res, locales, data) => {
    return res.status(200).json(createResponse(200, { data }, locales))
}

const unauthorized = (res, locales) => {
    return res.status(401).json(createResponse(401, {}, locales))
}

// Generate methods

const encryptTime = (req, res) => {
    const time = encryptData(`${Date.now()}`)
    const locales = res.locals.i18n.translations
    checkPayload(req.body)
        ? authorized(res, locales, { data: time })
        : unauthorized(res, locales)
}

const encryptData = (message) => {
    const algorithm = authConfig.encodeAlg
    const initVectr = crypto.randomBytes(16)
    const secretKey = crypto.randomBytes(32)
    const cipher = crypto.createCipheriv(algorithm, secretKey, initVectr)
    return {
        init_vectr: initVectr.toString('base64'),
        secret_key: secretKey.toString('base64'),
        random: cipher.update(message, 'utf-8', 'hex') + cipher.final('hex'),
    }
}

const decryptData = ({ init_vectr, secret_key, random }) => {
    const algorithm = authConfig.encodeAlg
    const initVectr = Buffer.from(init_vectr, 'base64')
    const secretKey = Buffer.from(secret_key, 'base64')
    const decipher = crypto.createDecipheriv(algorithm, secretKey, initVectr)
    return decipher.update(random, 'hex', 'utf-8') + decipher.final('utf8')
}

const generateToken = (req, res) => {
    // 1 min = 60000 ms
    const datetime = Date.now()
    const timehash = req.query.timehash
    const prevtime = decryptData({ ...req.body, random: timehash })
    const token = getSignMethod(signJwtToken, req.body)
    const locales = res.locals.i18n.translations

    datetime - prevtime <= 60000 && checkPayload(req.body)
        ? authorized(res, locales, { token })
        : unauthorized(res, locales)
}

const checkPayload = ({ username, password, userrole, method_id }) => {
    return (
        authConfig.defineUserRole.indexOf(userrole) !== -1 &&
        authConfig.mockedUsername === username &&
        authConfig.mockedPassword === password &&
        method_id
    )
}

const getSignMethod = (obj, { username, password, userrole, method_id }) => {
    const signJwtMethod = {
        eno: () => obj.method_1({ username, userrole }),
        owt: () => obj.method_2({ username, userrole, password }),
    }
    return signJwtMethod[method_id]()
}

const signJwtToken = {
    method_1: (payload) => {
        return jwt.sign(payload, authConfig.jwtSecret, {
            expiresIn: authConfig.jwtExpiry,
        })
    },
    method_2: (payload) => {
        return jwt.sign(payload, privateKey, authConfig.signOption)
    },
}

// Verify methods

const checkJwtToken = (req, res, next) => {
    let token = req.headers['authorization']
    let method_id = req.headers['x-access-method']
    const locales = res.locals.i18n.translations

    if (NODE_ENV === 'testing') return next()

    token =
        token && token.startsWith('Bearer ')
            ? token.slice(7, token.length)
            : undefined

    token && method_id
        ? (decode = getVerifyMethod(verifyJwtToken, { token, method_id }))
            ? ((req.headers.userrole = decode.userrole), next()) // ok
            : unauthorized(res, locales)
        : unauthorized(res, locales)
}

const getVerifyMethod = (obj, { token, method_id }) => {
    const verifyJwtMethod = {
        eno: () => obj.method_1(token),
        owt: () => obj.method_2(token),
    }
    return verifyJwtMethod[method_id]()
}

const verifyJwtToken = {
    method_1: (token) => {
        return jwt.verify(token, authConfig.jwtSecret, (err, decode) =>
            err ? null : decode
        )
    },
    method_2: (token) => {
        return jwt.verify(
            token,
            publicKey,
            authConfig.signOption,
            (err, decode) => (err ? null : decode)
        )
    },
}

// Authorized Methods

const isAuth = (targets) => {
    return (req, res, next) => {
        const curRole = req.headers.userrole
        const locales = res.locals.i18n.translations
        const curTarget = targets.find((target) => target == curRole)
        const targetAccess = sumPermission(curTarget || 'developer')
        const permitAccess = sumPermission(curRole)

        permitAccess >= targetAccess ? next() : unauthorized(res, locales)
    }
}

// Generate Token Routes
router.post('/u-tsh', encryptTime)
router.post('/u-bar', generateToken)

module.exports = {
    isAuth: isAuth,
    tokenRouter: router,
    verifyToken: checkJwtToken,
    signToken_1: signJwtToken.method_1, // dashboard user lamat
    signToken_2: signJwtToken.method_2, // explore api to other
}
