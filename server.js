require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const axios = require('axios'); // Add axios for HTTP requests

// Initialize the app
const app = express();

// Middleware
app.use(cors({ 
  origin: ['https://kenyaonabudgetsafaris.co.uk', 'http://localhost:3000'],
  credentials: true 
}));
app.use(bodyParser.json());

// Check if required environment variables are set
const missingVars = [];
['FIREBASE_PROJECT_ID', 'FIREBASE_PRIVATE_KEY', 'FIREBASE_CLIENT_EMAIL'].forEach(varName => {
  if (!process.env[varName]) missingVars.push(varName);
});

if (missingVars.length > 0) {
  console.error(`ERROR: Missing required environment variables: ${missingVars.join(', ')}`);
  console.error('Please set these variables in your Render dashboard or .env file');
}

// Initialize Firebase - with error handling
try {
  let firebaseConfig = {};
  
  // Check for credentials in environment variables
  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL) {
    // Construct the Firebase config
    firebaseConfig = {
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    };
    
    // Handle the private key (which might contain newlines)
    if (process.env.FIREBASE_PRIVATE_KEY) {
      // Handle both formats: with or without quotes and escaped newlines
      const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
      firebaseConfig.privateKey = privateKey;
    }
  } 
  
  // Check for JSON credential string
  else if (process.env.FIREBASE_CREDENTIALS_JSON) {
    try {
      const credentials = JSON.parse(process.env.FIREBASE_CREDENTIALS_JSON);
      firebaseConfig = credentials;
    } catch (e) {
      console.error('Error parsing FIREBASE_CREDENTIALS_JSON:', e);
    }
  }

  // Initialize Firebase if we have config
  if (Object.keys(firebaseConfig).length > 0) {
    admin.initializeApp({
      credential: admin.credential.cert(firebaseConfig)
    });
    console.log('Firebase initialized successfully');
  } else {
    console.error('No Firebase configuration found. Firebase features will not work.');
  }
} catch (error) {
  console.error('Error initializing Firebase:', error);
}

const db = admin.firestore();

// Configuration
const CONFIG = {
  COMMISSION_RATE: 0.10, // 10% commission
  ADMIN_EMAILS: ['info@kenyaonabudgetsafaris.co.uk', 'amiraalexobbs@gmail.com'],
  MIN_PAYOUT_AMOUNT: 50, // Minimum amount in GBP for payouts
  EMAIL_CLOUD_FUNCTION: `https://us-central1-kenya-on-a-budget-safaris.cloudfunctions.net/sendEmailHTTP`,
  PROJECT_ID: 'kenya-on-a-budget-safaris',
  REGION: 'us-central1'
};

// Email setup - with ORIGINAL email configuration
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
});

// Helper Functions
function formatDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function generateReferralCode(userId, linkType) {
  const prefix = userId.substring(0, 4);
  const typePrefix = linkType.substring(0, 2);
  const random = crypto.randomBytes(3).toString('hex');
  const timestamp = Date.now().toString(36).substring(0, 4);
  
  return `${prefix}-${typePrefix}-${random}-${timestamp}`;
}

// New email sending function with improved logic and fallbacks
async function sendEmail(to, subject, htmlContent, options = {}) {
  const { isAdmin = false, emailKey = `email-${Date.now()}`, retries = 3 } = options;
  console.log(`Attempting to send email to ${to}: ${subject}`);
  
  // Try cloud function first (preferred method)
  try {
    console.log(`Sending email via cloud function to: ${to}`);
    const cloudFunctionUrl = CONFIG.EMAIL_CLOUD_FUNCTION;
    
    const response = await axios.post(cloudFunctionUrl, {
      to,
      subject,
      receiptHtml: htmlContent,
      isAdmin,
      emailKey
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://kenyaonabudgetsafaris.co.uk'
      }
    });
    
    if (response.status >= 200 && response.status < 300) {
      console.log(`Email sent successfully via cloud function to ${to}`);
      return true;
    }
    throw new Error(`HTTP error: ${response.status}`);
  } catch (error) {
    console.error(`Error sending email via cloud function to ${to}:`, error);
    
    // Fallback to nodemailer
    try {
      console.log(`Falling back to nodemailer for ${to}`);
      await transporter.sendMail({
        from: `"Kenya on a Budget Safaris" <${process.env.EMAIL_USER}>`,
        to,
        subject,
        html: htmlContent
      });
      console.log(`Email sent successfully via nodemailer to ${to}`);
      return true;
    } catch (error) {
      console.error(`Error sending email via nodemailer to ${to}:`, error);
      
      // Last resort - save to pendingEmails in Firestore
      if (db) {
        try {
          console.log(`Saving email to pendingEmails collection for ${to}`);
          // Check if there's already a pending email to avoid duplicates
          const pendingEmailsRef = db.collection('pendingEmails');
          const existingEmails = await pendingEmailsRef
            .where('to', '==', to)
            .where('emailKey', '==', emailKey)
            .where('processed', '==', false)
            .limit(1)
            .get();
            
          if (existingEmails.empty) {
            await pendingEmailsRef.add({
              to,
              subject,
              receiptHtml: htmlContent,
              isAdmin,
              timestamp: admin.firestore.FieldValue.serverTimestamp(),
              processed: false,
              emailKey,
              retryCount: 0,
              lastAttempt: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log(`Email saved to pendingEmails collection for ${to}`);
            return true;
          } else {
            console.log(`Pending email already exists for ${to}, skipping to avoid duplicate`);
            return true;
          }
        } catch (error) {
          console.error(`Error saving email to pendingEmails for ${to}:`, error);
          return false;
        }
      }
      
      if (retries > 0) {
        console.log(`Retrying email send to ${to}, ${retries} attempts remaining`);
        return await sendEmail(to, subject, htmlContent, { ...options, retries: retries - 1 });
      }
      
      return false;
    }
  }
}

// API Endpoints - Using the original client paths

// Track affiliate clicks - Original path
app.post('/click', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Firebase not initialized' });
    
    const { refCode, url, path, userAgent, deviceType, source, timestamp } = req.body;

    // Find the referral link by refCode
    const linksSnapshot = await db.collection('referralLinks')
      .where('refCode', '==', refCode)
      .limit(1)
      .get();

    if (linksSnapshot.empty) {
      return res.status(404).json({ error: 'Referral link not found' });
    }

    const linkDoc = linksSnapshot.docs[0];
    const linkData = linkDoc.data();
    const linkId = linkDoc.id;
    const affiliateId = linkData.affiliateId;

    // Update click count on the link
    await db.collection('referralLinks').doc(linkId).update({
      clicks: admin.firestore.FieldValue.increment(1)
    });

    // Record the click with details
    const clickData = {
      affiliateId: affiliateId,
      linkId: linkId,
      refCode: refCode,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      date: admin.firestore.Timestamp.fromDate(new Date()),
      url: url,
      path: path,
      userAgent: userAgent,
      deviceType: deviceType,
      source: source,
      converted: false
    };

    const clickRef = await db.collection('clicks').add(clickData);
    
    // Update statistics
    await updateClickStatistics(affiliateId, linkId, deviceType, source);

    res.json({ success: true, clickId: clickRef.id });
  } catch (error) {
    console.error('Error tracking click:', error);
    res.status(500).json({ error: 'Error tracking click', details: error.message });
  }
});

// Track conversions - Original path
app.post('/conversion', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Firebase not initialized' });
    
    const { 
      affiliateCode, 
      clickId, 
      purchaseAmount, 
      packageId, 
      packageName, 
      bookingId, 
      sessionId, 
      currency, 
      customerEmail, 
      customerName 
    } = req.body;

    // Find the referral link by refCode
    const linksSnapshot = await db.collection('referralLinks')
      .where('refCode', '==', affiliateCode)
      .limit(1)
      .get();

    if (linksSnapshot.empty) {
      return res.status(404).json({ error: 'Referral link not found' });
    }

    const linkDoc = linksSnapshot.docs[0];
    const linkData = linkDoc.data();
    const linkId = linkDoc.id;
    const affiliateId = linkData.affiliateId;

    // Calculate commission
    const commissionAmount = parseFloat(purchaseAmount) * CONFIG.COMMISSION_RATE;

    // Create the conversion record
    const conversionData = {
      affiliateId: affiliateId,
      linkId: linkId,
      refCode: affiliateCode,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      date: admin.firestore.Timestamp.fromDate(new Date()),
      purchaseAmount: parseFloat(purchaseAmount),
      commissionAmount: commissionAmount,
      packageId: packageId || '',
      packageName: packageName || 'Unknown Package',
      bookingId: bookingId || '',
      sessionId: sessionId || '',
      status: 'pending', // Initial status is pending, will be approved later
      currency: currency || 'gbp',
      customerEmail: customerEmail || null,
      customerName: customerName || ''
    };

    // If we have a click ID, update it
    if (clickId) {
      try {
        await db.collection('clicks').doc(clickId).update({
          converted: true,
          conversionTimestamp: admin.firestore.FieldValue.serverTimestamp(),
          purchaseAmount: parseFloat(purchaseAmount),
          commissionAmount: commissionAmount
        });
        
        // Add click ID to conversion data
        conversionData.clickId = clickId;
      } catch (error) {
        console.error('Error updating click record:', error);
      }
    }

    // Add the conversion to the database
    const conversionRef = await db.collection('conversions').add(conversionData);

    // Update link stats
    await db.collection('referralLinks').doc(linkId).update({
      conversions: admin.firestore.FieldValue.increment(1),
      earnings: admin.firestore.FieldValue.increment(commissionAmount)
    });

    // Update affiliate balance
    await updateAffiliateBalance(affiliateId, commissionAmount);

    // Update statistics
    await updateConversionStatistics(affiliateId, linkId, parseFloat(purchaseAmount), commissionAmount);

    // Send email notifications
    await sendConversionEmails(affiliateId, linkId, parseFloat(purchaseAmount), commissionAmount, {
      packageName: packageName,
      customerEmail: customerEmail,
      customerName: customerName
    });

    res.json({ success: true, conversionId: conversionRef.id });
  } catch (error) {
    console.error('Error tracking conversion:', error);
    res.status(500).json({ error: 'Error tracking conversion', details: error.message });
  }
});

// Register new affiliate - Original path
app.post('/register', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Firebase not initialized' });
    
    const { name, email, phone, website, bio, password } = req.body;

    // Create user account in Firebase Auth
    const userRecord = await admin.auth().createUser({
      email: email,
      password: password || crypto.randomBytes(8).toString('hex'),
      displayName: name
    });

    // Create affiliate record
    const affiliateData = {
      name: name,
      email: email,
      phone: phone || '',
      website: website || '',
      bio: bio || '',
      role: 'Travel Affiliate',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      totalReferrals: 0,
      monthlyEarnings: 0,
      totalEarnings: 0,
      conversionRate: 0,
      referralChange: 0,
      revenueChange: 0,
      conversionRateChange: 0
    };

    await db.collection('affiliates').doc(userRecord.uid).set(affiliateData);

    // Create initial referral links
    await createInitialReferralLinks(userRecord.uid);

    // Create initial balance document
    await db.collection('balances').add({
      userId: userRecord.uid,
      available: 0,
      pending: 0,
      paid: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Send welcome emails
    await sendWelcomeEmails(userRecord.uid, affiliateData, password);

    res.json({ success: true, userId: userRecord.uid });
  } catch (error) {
    console.error('Error registering affiliate:', error);
    
    // If email already exists, try to handle gracefully
    if (error.code === 'auth/email-already-exists') {
      return res.status(400).json({ 
        success: false, 
        message: 'This email is already registered. Please login with your existing account.'
      });
    }
    
    res.status(500).json({ 
      success: false, 
      message: 'Error creating affiliate account', 
      error: error.message 
    });
  }
});

// Get dashboard data - Original path
app.get('/dashboard', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Firebase not initialized' });
    
    // Get the current user ID from auth token
    const idToken = req.headers.authorization?.split('Bearer ')[1];
    
    if (!idToken) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const userId = decodedToken.uid;
    
    // Get affiliate profile
    const affiliateDoc = await db.collection('affiliates').doc(userId).get();
    
    if (!affiliateDoc.exists) {
      return res.status(404).json({ error: 'Affiliate not found' });
    }
    
    const profile = affiliateDoc.data();
    
    // Get balance
    const balanceSnapshot = await db.collection('balances')
      .where('userId', '==', userId)
      .limit(1)
      .get();
      
    let balance = { available: 0, pending: 0, paid: 0 };
    
    if (!balanceSnapshot.empty) {
      balance = balanceSnapshot.docs[0].data();
    }
    
    // Get referral links
    const linksSnapshot = await db.collection('referralLinks')
      .where('affiliateId', '==', userId)
      .get();
      
    const links = linksSnapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        refCode: data.refCode,
        linkType: data.linkType,
        clicks: data.clicks || 0,
        conversions: data.conversions || 0,
        earnings: data.earnings || 0
      };
    });
    
    // Get recent conversions
    const conversionsSnapshot = await db.collection('conversions')
      .where('affiliateId', '==', userId)
      .orderBy('timestamp', 'desc')
      .limit(10)
      .get();
      
    const conversions = conversionsSnapshot.docs.map(doc => doc.data());
    
    // Return all data
    res.json({
      profile,
      balance,
      links,
      conversions
    });
  } catch (error) {
    console.error('Error getting dashboard data:', error);
    res.status(500).json({ error: 'Error getting dashboard data', details: error.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  const status = {
    status: 'OK',
    message: 'Server is running',
    environment: process.env.NODE_ENV || 'development',
    firebaseInitialized: !!db,
    emailInitialized: !!transporter,
    timestamp: new Date().toISOString()
  };
  
  res.status(200).json(status);
});

// Helper Functions for API operations

async function updateClickStatistics(affiliateId, linkId, deviceType, source) {
  try {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const formattedDate = formatDate(today);
    
    // Update daily stats
    const dailyStatsRef = db.collection('dailyStats').doc(`${affiliateId}_${formattedDate}`);
    
    await db.runTransaction(async transaction => {
      const docSnapshot = await transaction.get(dailyStatsRef);
      
      if (!docSnapshot.exists) {
        transaction.set(dailyStatsRef, {
          affiliateId: affiliateId,
          date: admin.firestore.Timestamp.fromDate(today),
          clicks: 1,
          conversions: 0,
          earnings: 0
        });
      } else {
        transaction.update(dailyStatsRef, {
          clicks: admin.firestore.FieldValue.increment(1)
        });
      }
    });
    
    // Update device stats
    await db.collection('deviceStats').doc(`${affiliateId}_${formattedDate}_${deviceType}`).set({
      affiliateId: affiliateId,
      date: admin.firestore.Timestamp.fromDate(today),
      device: deviceType,
      clicks: admin.firestore.FieldValue.increment(1)
    }, { merge: true });
    
    // Update source stats
    await db.collection('sourceStats').doc(`${affiliateId}_${formattedDate}_${source}`).set({
      affiliateId: affiliateId,
      date: admin.firestore.Timestamp.fromDate(today),
      source: source,
      clicks: admin.firestore.FieldValue.increment(1)
    }, { merge: true });
    
    // Update affiliate stats
    await db.collection('affiliateStats').doc(`${affiliateId}_${formattedDate}`).set({
      userId: affiliateId,
      date: admin.firestore.Timestamp.fromDate(today),
      impressions: admin.firestore.FieldValue.increment(1),
      clicks: admin.firestore.FieldValue.increment(1)
    }, { merge: true });
    
    // Update link performance
    await db.collection('linkPerformance').doc(`${linkId}_${formattedDate}`).set({
      linkId: linkId,
      affiliateId: affiliateId,
      date: admin.firestore.Timestamp.fromDate(today),
      clicks: admin.firestore.FieldValue.increment(1)
    }, { merge: true });
  } catch (error) {
    console.error('Error updating click statistics:', error);
  }
}

async function updateAffiliateBalance(affiliateId, commissionAmount) {
  try {
    // Get the balances document for this affiliate
    const balancesSnapshot = await db.collection('balances')
      .where('userId', '==', affiliateId)
      .limit(1)
      .get();
    
    if (balancesSnapshot.empty) {
      // Create a new balance document
      await db.collection('balances').add({
        userId: affiliateId,
        available: 0,
        pending: commissionAmount,
        paid: 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    } else {
      // Update existing balance document
      const balanceDoc = balancesSnapshot.docs[0];
      await balanceDoc.ref.update({
        pending: admin.firestore.FieldValue.increment(commissionAmount),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
    
    // Add an earnings transaction record
    await db.collection('earnings').add({
      userId: affiliateId,
      amount: commissionAmount,
      date: admin.firestore.FieldValue.serverTimestamp(),
      status: 'pending',
      source: 'Referral',
      description: 'Commission on booking',
      packageName: 'Safari Package',
      referenceId: 'COMM-' + crypto.randomBytes(3).toString('hex').toUpperCase(),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (error) {
    console.error('Error updating affiliate balance:', error);
  }
}

async function updateConversionStatistics(affiliateId, linkId, purchaseAmount, commissionAmount) {
  try {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const formattedDate = formatDate(today);
    
    // Update daily stats
    const dailyStatsRef = db.collection('dailyStats').doc(`${affiliateId}_${formattedDate}`);
    
    await db.runTransaction(async transaction => {
      const docSnapshot = await transaction.get(dailyStatsRef);
      
      if (!docSnapshot.exists) {
        transaction.set(dailyStatsRef, {
          affiliateId: affiliateId,
          date: admin.firestore.Timestamp.fromDate(today),
          clicks: 0,
          conversions: 1,
          earnings: commissionAmount
        });
      } else {
        transaction.update(dailyStatsRef, {
          conversions: admin.firestore.FieldValue.increment(1),
          earnings: admin.firestore.FieldValue.increment(commissionAmount)
        });
      }
    });
    
    // Update monthly earnings
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    await db.collection('monthlyEarnings').doc(`${affiliateId}_${formatDate(monthStart)}`).set({
      userId: affiliateId,
      month: admin.firestore.Timestamp.fromDate(monthStart),
      amount: admin.firestore.FieldValue.increment(commissionAmount),
      count: admin.firestore.FieldValue.increment(1),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    
    // Update affiliate stats
    await db.collection('affiliateStats').doc(`${affiliateId}_${formattedDate}`).set({
      userId: affiliateId,
      date: admin.firestore.Timestamp.fromDate(today),
      conversions: admin.firestore.FieldValue.increment(1),
      earnings: admin.firestore.FieldValue.increment(commissionAmount)
    }, { merge: true });
    
    // Update link performance
    await db.collection('linkPerformance').doc(`${linkId}_${formattedDate}`).set({
      linkId: linkId,
      affiliateId: affiliateId,
      date: admin.firestore.Timestamp.fromDate(today),
      conversions: admin.firestore.FieldValue.increment(1),
      earnings: admin.firestore.FieldValue.increment(commissionAmount)
    }, { merge: true });
  } catch (error) {
    console.error('Error updating conversion statistics:', error);
  }
}

async function createInitialReferralLinks(userId) {
  try {
    const linkTypes = ['general', 'facebook', 'twitter', 'instagram', 'tiktok'];
    
    // Create a link for each type
    const linkPromises = linkTypes.map(linkType => {
      const refCode = generateReferralCode(userId, linkType);
      
      return db.collection('referralLinks').add({
        affiliateId: userId,
        linkType: linkType,
        refCode: refCode,
        targetPage: '/',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        clicks: 0,
        conversions: 0,
        earnings: 0
      });
    });
    
    await Promise.all(linkPromises);
  } catch (error) {
    console.error('Error creating initial referral links:', error);
  }
}

// Updated conversion email function with modern template
async function sendConversionEmails(affiliateId, linkId, purchaseAmount, commissionAmount, details) {
  try {
    // Get affiliate details
    const affiliateDoc = await db.collection('affiliates').doc(affiliateId).get();
    
    if (!affiliateDoc.exists) {
      console.error('Affiliate not found for sending emails');
      return;
    }
    
    const affiliateData = affiliateDoc.data();
    const packageName = details.packageName || 'Safari Package';
    const formattedCommission = commissionAmount.toFixed(2);
    const formattedPurchase = purchaseAmount.toFixed(2);
    const referenceId = 'COMM-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    
    // Generate a unique receipt number for this conversion
    const receiptNumber = `CONV-${Date.now().toString(36).substring(3, 9).toUpperCase()}`;
    
    // Current date formatted nicely
    const currentDate = new Date().toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'long',
      year: 'numeric'
    }) + ' at ' + new Date().toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit'
    });
    
    // Send email to affiliate with modern template
    if (affiliateData.email) {
      const affiliateEmailHtml = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>New Commission Earned - KenyaOnABudget Safaris</title>
        </head>
        <body style="font-family: Arial, Helvetica, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f7f7f7;">
          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width: 650px; margin: 0 auto; background-color: #ffffff;">
            <!-- Header -->
            <tr>
              <td style="padding: 20px; text-align: center; background-color: #ffffff; border-bottom: 1px solid #e0e0e0;">
                <table width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td>
                      <div style="display: inline-block; width: 50px; height: 50px; background-color: #f5f5f5; border-radius: 8px; text-align: center; line-height: 50px; font-weight: bold; font-size: 24px; color: #e67e22;">K</div>
                    </td>
                    <td style="padding-left: 15px; text-align: left;">
                      <h1 style="margin: 0; font-size: 24px; color: #e67e22;">KenyaOnABudget Safaris</h1>
                      <p style="margin: 5px 0 0; font-size: 14px; color: #666;">Kenya On Your Terms: Smart Or Grand We Make it Happen!</p>
                    </td>
                  </tr>
                </table>
                <p style="margin-top: 15px; font-size: 14px; color: #666; text-align: right;">
                  Commission Alert #${referenceId}<br>
                  ${currentDate}
                </p>
              </td>
            </tr>
            
            <!-- Banner -->
            <tr>
              <td style="padding: 30px 20px; background-color: #e67e22; color: #ffffff;">
                <h2 style="margin: 0 0 10px; font-size: 24px;">New Commission Earned!</h2>
                <p style="margin: 0 0 15px; font-size: 18px;">Great news! You've just earned a commission from a new booking.</p>
                <p style="margin: 0; font-size: 16px; background-color: rgba(255,255,255,0.2); display: inline-block; padding: 5px 10px; border-radius: 4px;">Commission: £${formattedCommission}</p>
              </td>
            </tr>
            
            <!-- Commission Information -->
            <tr>
              <td style="padding: 30px 20px;">
                <h3 style="margin: 0 0 20px; font-size: 18px; color: #e67e22; border-bottom: 2px solid #e67e22; padding-bottom: 10px;">Booking Details</h3>
                <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 20px; background-color: #f8f8f8; border-radius: 8px; border-left: 4px solid #e67e22;">
                  <tr>
                    <td style="padding: 20px;">
                      <table width="100%" cellpadding="0" cellspacing="0" border="0">
                        <tr>
                          <td width="50%" valign="top" style="padding-bottom: 15px;">
                            <p style="margin: 0 0 5px; font-size: 12px; color: #666; text-transform: uppercase; font-weight: bold;">Package</p>
                            <p style="margin: 0; font-size: 16px; font-weight: 600;">${packageName}</p>
                          </td>
                          <td width="50%" valign="top" style="padding-bottom: 15px;">
                            <p style="margin: 0 0 5px; font-size: 12px; color: #666; text-transform: uppercase; font-weight: bold;">Booking Amount</p>
                            <p style="margin: 0; font-size: 16px; font-weight: 600;">£${formattedPurchase}</p>
                          </td>
                        </tr>
                        <tr>
                          <td width="50%" valign="top" style="padding-bottom: 15px;">
                            <p style="margin: 0 0 5px; font-size: 12px; color: #666; text-transform: uppercase; font-weight: bold;">Your Commission (10%)</p>
                            <p style="margin: 0; font-size: 16px; font-weight: 600;">£${formattedCommission}</p>
                          </td>
                          <td width="50%" valign="top" style="padding-bottom: 15px;">
                            <p style="margin: 0 0 5px; font-size: 12px; color: #666; text-transform: uppercase; font-weight: bold;">Status</p>
                            <p style="margin: 0; font-size: 16px; font-weight: 600; display: inline-block; padding: 3px 10px; background-color: #FFB74D; color: white; border-radius: 12px;">Pending</p>
                          </td>
                        </tr>
                        <tr>
                          <td width="50%" valign="top">
                            <p style="margin: 0 0 5px; font-size: 12px; color: #666; text-transform: uppercase; font-weight: bold;">Reference ID</p>
                            <p style="margin: 0; font-size: 16px; font-weight: 600;">${referenceId}</p>
                          </td>
                          <td width="50%" valign="top">
                            <p style="margin: 0 0 5px; font-size: 12px; color: #666; text-transform: uppercase; font-weight: bold;">Date</p>
                            <p style="margin: 0; font-size: 16px; font-weight: 600;">${currentDate}</p>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>
                
                <p style="margin-bottom: 20px; font-size: 16px; color: #444; line-height: 1.5;">
                  This commission will be added to your affiliate dashboard and will be available for withdrawal once the booking is confirmed.
                </p>
                
                <p style="margin-bottom: 30px; font-size: 16px; color: #444; line-height: 1.5;">
                  Keep up the great work promoting our safaris!
                </p>
                
                <div style="text-align: center;">
                  <a href="https://kenyaonabudgetsafaris.co.uk/affiliate-dashboard.html" style="background-color: #e67e22; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: 600; display: inline-block;">View Your Dashboard</a>
                </div>
                
                <!-- Thank You Message -->
                <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 30px 0 10px; text-align: center; border-top: 1px dashed #e0e0e0; border-bottom: 1px dashed #e0e0e0;">
                  <tr>
                    <td style="padding: 30px 0;">
                      <p style="margin: 0; font-size: 16px; color: #444; font-style: italic;">Thank you for being a valued affiliate partner of KenyaOnABudget Safaris!</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            
            <!-- Footer -->
            <tr>
              <td style="padding: 20px; background-color: #f5f5f5; text-align: center; font-size: 14px; color: #666;">
                <p style="margin: 0 0 10px; font-weight: 700; color: #555; font-size: 16px;">KenyaOnABudget Safaris</p>
                <p style="margin: 0 0 10px;">FARINGDON (SN7), SHELLINGFORD, FERNHAM ROAD<br>UNITED KINGDOM</p>
                <p style="margin: 10px 0;">
                  Email: <a href="mailto:info@kenyaonabudgetsafaris.co.uk" style="color: #e67e22; text-decoration: none;">info@kenyaonabudgetsafaris.co.uk</a> | 
                  Phone: +44 7376 642 148
                </p>
                <p style="margin: 20px 0 0; font-size: 12px; color: #777;">
                  &copy; ${new Date().getFullYear()} KenyaOnABudget Safaris. All rights reserved.
                </p>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `;
      
      // Send the email with our new email function
      await sendEmail(
        affiliateData.email,
        'New Commission Earned - KenyaOnABudget Safaris',
        affiliateEmailHtml,
        {
          isAdmin: false,
          emailKey: `commission-${affiliateId}-${receiptNumber}-${Date.now()}`
        }
      );
    }
    
    // Send email to admin with modern template
    const adminEmailHtml = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Affiliate Conversion Alert - KenyaOnABudget Safaris</title>
      </head>
      <body style="font-family: Arial, Helvetica, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f7f7f7;">
        <table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width: 650px; margin: 0 auto; background-color: #ffffff;">
          <!-- Header -->
          <tr>
            <td style="padding: 20px; text-align: center; background-color: #ffffff; border-bottom: 1px solid #e0e0e0;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td>
                    <div style="display: inline-block; width: 50px; height: 50px; background-color: #f5f5f5; border-radius: 8px; text-align: center; line-height: 50px; font-weight: bold; font-size: 24px; color: #e67e22;">K</div>
                  </td>
                  <td style="padding-left: 15px; text-align: left;">
                    <h1 style="margin: 0; font-size: 24px; color: #e67e22;">KenyaOnABudget Safaris</h1>
                    <p style="margin: 5px 0 0; font-size: 14px; color: #666;">Kenya On Your Terms: Smart Or Grand We Make it Happen!</p>
                  </td>
                </tr>
              </table>
              <p style="margin-top: 15px; font-size: 14px; color: #666; text-align: right;">
                Conversion Alert #${referenceId}<br>
                ${currentDate}
              </p>
            </td>
          </tr>
          
          <!-- Banner -->
          <tr>
            <td style="padding: 30px 20px; background-color: #e67e22; color: #ffffff;">
              <h2 style="margin: 0 0 10px; font-size: 24px;">Affiliate Conversion Alert</h2>
              <p style="margin: 0 0 15px; font-size: 18px;">A new booking has been made through an affiliate link</p>
              <p style="margin: 0; font-size: 16px; background-color: rgba(255,255,255,0.2); display: inline-block; padding: 5px 10px; border-radius: 4px;">Amount: £${formattedPurchase}</p>
            </td>
          </tr>
          
          <!-- Conversion Information -->
          <tr>
            <td style="padding: 30px 20px;">
              <h3 style="margin: 0 0 20px; font-size: 18px; color: #e67e22; border-bottom: 2px solid #e67e22; padding-bottom: 10px;">Conversion Details</h3>
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 20px; background-color: #f8f8f8; border-radius: 8px; border-left: 4px solid #e67e22;">
                <tr>
                  <td style="padding: 20px;">
                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td width="50%" valign="top" style="padding-bottom: 15px;">
                          <p style="margin: 0 0 5px; font-size: 12px; color: #666; text-transform: uppercase; font-weight: bold;">Affiliate</p>
                          <p style="margin: 0; font-size: 16px; font-weight: 600;">${affiliateData.name} (${affiliateData.email})</p>
                        </td>
                        <td width="50%" valign="top" style="padding-bottom: 15px;">
                          <p style="margin: 0 0 5px; font-size: 12px; color: #666; text-transform: uppercase; font-weight: bold;">Package</p>
                          <p style="margin: 0; font-size: 16px; font-weight: 600;">${packageName}</p>
                        </td>
                      </tr>
                      <tr>
                        <td width="50%" valign="top" style="padding-bottom: 15px;">
                          <p style="margin: 0 0 5px; font-size: 12px; color: #666; text-transform: uppercase; font-weight: bold;">Booking Amount</p>
                          <p style="margin: 0; font-size: 16px; font-weight: 600;">£${formattedPurchase}</p>
                        </td>
                        <td width="50%" valign="top" style="padding-bottom: 15px;">
                          <p style="margin: 0 0 5px; font-size: 12px; color: #666; text-transform: uppercase; font-weight: bold;">Commission (10%)</p>
                          <p style="margin: 0; font-size: 16px; font-weight: 600;">£${formattedCommission}</p>
                        </td>
                      </tr>
                      <tr>
                        <td width="50%" valign="top" style="padding-bottom: 15px;">
                          <p style="margin: 0 0 5px; font-size: 12px; color: #666; text-transform: uppercase; font-weight: bold;">Customer</p>
                          <p style="margin: 0; font-size: 16px; font-weight: 600;">${details.customerName || 'Not provided'} (${details.customerEmail || 'No email'})</p>
                        </td>
                        <td width="50%" valign="top" style="padding-bottom: 15px;">
                          <p style="margin: 0 0 5px; font-size: 12px; color: #666; text-transform: uppercase; font-weight: bold;">Time</p>
                          <p style="margin: 0; font-size: 16px; font-weight: 600;">${currentDate}</p>
                        </td>
                      </tr>
                      <tr>
                        <td width="50%" valign="top">
                          <p style="margin: 0 0 5px; font-size: 12px; color: #666; text-transform: uppercase; font-weight: bold;">Reference ID</p>
                          <p style="margin: 0; font-size: 16px; font-weight: 600;">${referenceId}</p>
                        </td>
                        <td width="50%" valign="top">
                          <p style="margin: 0 0 5px; font-size: 12px; color: #666; text-transform: uppercase; font-weight: bold;">Status</p>
                          <p style="margin: 0; font-size: 16px; font-weight: 600; display: inline-block; padding: 3px 10px; background-color: #FFB74D; color: white; border-radius: 12px;">Pending Approval</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
              
              <p style="margin-bottom: 20px; font-size: 16px; color: #444; line-height: 1.5;">
                This commission is pending and will need to be approved before it becomes available to the affiliate.
              </p>
              
              <div style="text-align: center;">
                <a href="https://kenyaonabudgetsafaris.co.uk/admin/affiliates.html" style="background-color: #e67e22; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: 600; display: inline-block;">View in Admin Panel</a>
              </div>
              
              <!-- System Info -->
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 30px 0 10px; text-align: center; border-top: 1px dashed #e0e0e0;">
                <tr>
                  <td style="padding: 30px 0 10px;">
                    <p style="margin: 0; font-size: 14px; color: #777;">This message was automatically generated by the affiliate tracking system.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 20px; background-color: #f5f5f5; text-align: center; font-size: 14px; color: #666;">
              <p style="margin: 0 0 10px; font-weight: 700; color: #555; font-size: 16px;">KenyaOnABudget Safaris</p>
              <p style="margin: 0 0 10px;">FARINGDON (SN7), SHELLINGFORD, FERNHAM ROAD<br>UNITED KINGDOM</p>
              <p style="margin: 10px 0;">
                Email: <a href="mailto:info@kenyaonabudgetsafaris.co.uk" style="color: #e67e22; text-decoration: none;">info@kenyaonabudgetsafaris.co.uk</a> | 
                Phone: +44 7376 642 148
              </p>
              <p style="margin: 20px 0 0; font-size: 12px; color: #777;">
                &copy; ${new Date().getFullYear()} KenyaOnABudget Safaris. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `;
    
    // Send to all admin emails with our new email function
    for (const adminEmail of CONFIG.ADMIN_EMAILS) {
      await sendEmail(
        adminEmail,
        'New Affiliate Conversion - KenyaOnABudget Safaris',
        adminEmailHtml,
        {
          isAdmin: true,
          emailKey: `admin-conversion-${adminEmail}-${receiptNumber}-${Date.now()}`
        }
      );
    }
  } catch (error) {
    console.error('Error sending conversion emails:', error);
  }
}

// Updated welcome email function with modern template
async function sendWelcomeEmails(userId, affiliateData, password) {
  try {
    // Generate welcome email content for affiliate with modern template
    const passwordSection = password ? `
      <div style="background-color: #f8f8f8; padding: 15px; margin: 20px 0; border-radius: 8px; border-left: 4px solid #e67e22;">
        <p style="margin: 0 0 10px; font-size: 16px; font-weight: 600; color: #444;">Your login details:</p>
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td width="30%" style="padding-bottom: 10px;">
              <p style="margin: 0; font-size: 14px; color: #666; font-weight: bold;">Email:</p>
            </td>
            <td width="70%" style="padding-bottom: 10px;">
              <p style="margin: 0; font-size: 14px; color: #444;">${affiliateData.email}</p>
            </td>
          </tr>
          <tr>
            <td width="30%">
              <p style="margin: 0; font-size: 14px; color: #666; font-weight: bold;">Password:</p>
            </td>
            <td width="70%">
              <p style="margin: 0; font-size: 14px; color: #444;">${password}</p>
            </td>
          </tr>
        </table>
        <p style="margin: 10px 0 0; color: #e74c3c; font-size: 13px;">Please save this information and change your password after logging in.</p>
      </div>
    ` : '';
    
    const affiliateEmailHtml = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Welcome to KenyaOnABudget Affiliate Program!</title>
      </head>
      <body style="font-family: Arial, Helvetica, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f7f7f7;">
        <table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width: 650px; margin: 0 auto; background-color: #ffffff;">
          <!-- Header -->
          <tr>
            <td style="padding: 20px; text-align: center; background-color: #ffffff; border-bottom: 1px solid #e0e0e0;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td>
                    <div style="display: inline-block; width: 50px; height: 50px; background-color: #f5f5f5; border-radius: 8px; text-align: center; line-height: 50px; font-weight: bold; font-size: 24px; color: #e67e22;">K</div>
                  </td>
                  <td style="padding-left: 15px; text-align: left;">
                    <h1 style="margin: 0; font-size: 24px; color: #e67e22;">KenyaOnABudget Safaris</h1>
                    <p style="margin: 5px 0 0; font-size: 14px; color: #666;">Kenya On Your Terms: Smart Or Grand We Make it Happen!</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Banner -->
          <tr>
            <td style="padding: 30px 20px; background-color: #e67e22; color: #ffffff;">
              <h2 style="margin: 0 0 10px; font-size: 24px;">Welcome to KenyaOnABudget Affiliate Program!</h2>
              <p style="margin: 0; font-size: 16px;">We're excited to have you on board as our new affiliate partner.</p>
            </td>
          </tr>
          
          <!-- Main Content -->
          <tr>
            <td style="padding: 30px 20px;">
              <p style="margin-bottom: 20px; font-size: 16px; color: #444; line-height: 1.5;">
                Hello ${affiliateData.name},
              </p>
              
              <p style="margin-bottom: 20px; font-size: 16px; color: #444; line-height: 1.5;">
                Welcome to the KenyaOnABudget Safaris Affiliate Program! As our affiliate partner, you'll earn 10% commission on every booking made through your unique referral links.
              </p>
              
              ${passwordSection}
              
              <h3 style="margin: 30px 0 20px; font-size: 18px; color: #e67e22; border-bottom: 2px solid #e67e22; padding-bottom: 10px;">Getting Started</h3>
              
              <ol style="margin: 0 0 30px; padding-left: 25px;">
                <li style="margin-bottom: 12px; font-size: 16px; color: #444;">Log in to your affiliate dashboard to access your unique referral links</li>
                <li style="margin-bottom: 12px; font-size: 16px; color: #444;">Share these links on your website, social media, or with your network</li>
                <li style="margin-bottom: 12px; font-size: 16px; color: #444;">Start earning 10% commission on every booking made through your links</li>
                <li style="margin-bottom: 12px; font-size: 16px; color: #444;">Track your performance and earnings in real-time from your dashboard</li>
                <li style="font-size: 16px; color: #444;">Request payouts once your balance reaches £${CONFIG.MIN_PAYOUT_AMOUNT}</li>
              </ol>
              
              <div style="text-align: center; margin: 30px 0;">
                <a href="https://kenyaonabudgetsafaris.co.uk/affiliate-dashboard.html" style="background-color: #e67e22; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: 600; display: inline-block;">Access Your Dashboard</a>
              </div>
              
              <!-- Support Section -->
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 30px 0; background-color: #f9f9f9; border-radius: 8px;">
                <tr>
                  <td style="padding: 20px;">
                    <h4 style="margin: 0 0 15px; color: #e67e22; font-size: 18px;">Need Help?</h4>
                    <p style="margin: 0; font-size: 16px; color: #444; line-height: 1.5;">
                      If you have any questions, please don't hesitate to contact us at <a href="mailto:info@kenyaonabudgetsafaris.co.uk" style="color: #e67e22; text-decoration: none;">info@kenyaonabudgetsafaris.co.uk</a>. We're here to help you succeed!
                    </p>
                  </td>
                </tr>
              </table>
              
              <!-- Thank You Message -->
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 30px 0 10px; text-align: center; border-top: 1px dashed #e0e0e0; border-bottom: 1px dashed #e0e0e0;">
                <tr>
                  <td style="padding: 30px 0;">
                    <h3 style="margin: 0 0 15px; color: #e67e22; font-size: 20px;">Thank You For Joining Our Team!</h3>
                    <p style="margin: 0; font-size: 16px; color: #444; font-style: italic;">We look forward to a successful partnership promoting amazing safari experiences in Kenya.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 20px; background-color: #f5f5f5; text-align: center; font-size: 14px; color: #666;">
              <p style="margin: 0 0 10px; font-weight: 700; color: #555; font-size: 16px;">KenyaOnABudget Safaris</p>
              <p style="margin: 0 0 10px;">FARINGDON (SN7), SHELLINGFORD, FERNHAM ROAD<br>UNITED KINGDOM</p>
              <p style="margin: 10px 0;">
                Email: <a href="mailto:info@kenyaonabudgetsafaris.co.uk" style="color: #e67e22; text-decoration: none;">info@kenyaonabudgetsafaris.co.uk</a> | 
                Phone: +44 7376 642 148
              </p>
              <p style="margin: 20px 0 0; font-size: 12px; color: #777;">
                &copy; ${new Date().getFullYear()} KenyaOnABudget Safaris. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `;
    
    // Send email to affiliate with our new email function
    await sendEmail(
      affiliateData.email, 
      'Welcome to KenyaOnABudget Affiliate Program!', 
      affiliateEmailHtml,
      {
        isAdmin: false,
        emailKey: `welcome-affiliate-${userId}-${Date.now()}`
      }
    );
    
    // Send notification to admin with modern template
    const adminEmailHtml = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>New Affiliate Registration - KenyaOnABudget Safaris</title>
      </head>
      <body style="font-family: Arial, Helvetica, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f7f7f7;">
        <table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width: 650px; margin: 0 auto; background-color: #ffffff;">
          <!-- Header -->
          <tr>
            <td style="padding: 20px; text-align: center; background-color: #ffffff; border-bottom: 1px solid #e0e0e0;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td>
                    <div style="display: inline-block; width: 50px; height: 50px; background-color: #f5f5f5; border-radius: 8px; text-align: center; line-height: 50px; font-weight: bold; font-size: 24px; color: #e67e22;">K</div>
                  </td>
                  <td style="padding-left: 15px; text-align: left;">
                    <h1 style="margin: 0; font-size: 24px; color: #e67e22;">KenyaOnABudget Safaris</h1>
                    <p style="margin: 5px 0 0; font-size: 14px; color: #666;">Kenya On Your Terms: Smart Or Grand We Make it Happen!</p>
                  </td>
                </tr>
              </table>
              <p style="margin-top: 15px; font-size: 14px; color: #666; text-align: right;">
                Registration Alert<br>
                ${new Date().toLocaleString()}
              </p>
            </td>
          </tr>
          
          <!-- Banner -->
          <tr>
            <td style="padding: 30px 20px; background-color: #e67e22; color: #ffffff;">
              <h2 style="margin: 0 0 10px; font-size: 24px;">New Affiliate Registration</h2>
              <p style="margin: 0; font-size: 16px;">A new affiliate has registered on the KenyaOnABudget Safaris website</p>
            </td>
          </tr>
          
          <!-- Affiliate Information -->
          <tr>
            <td style="padding: 30px 20px;">
              <h3 style="margin: 0 0 20px; font-size: 18px; color: #e67e22; border-bottom: 2px solid #e67e22; padding-bottom: 10px;">Affiliate Details</h3>
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 20px; background-color: #f8f8f8; border-radius: 8px; border-left: 4px solid #e67e22;">
                <tr>
                  <td style="padding: 20px;">
                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td width="50%" valign="top" style="padding-bottom: 15px;">
                          <p style="margin: 0 0 5px; font-size: 12px; color: #666; text-transform: uppercase; font-weight: bold;">Name</p>
                          <p style="margin: 0; font-size: 16px; font-weight: 600;">${affiliateData.name}</p>
                        </td>
                        <td width="50%" valign="top" style="padding-bottom: 15px;">
                          <p style="margin: 0 0 5px; font-size: 12px; color: #666; text-transform: uppercase; font-weight: bold;">Email</p>
                          <p style="margin: 0; font-size: 16px; font-weight: 600;">${affiliateData.email}</p>
                        </td>
                      </tr>
                      <tr>
                        <td width="50%" valign="top" style="padding-bottom: 15px;">
                          <p style="margin: 0 0 5px; font-size: 12px; color: #666; text-transform: uppercase; font-weight: bold;">Phone</p>
                          <p style="margin: 0; font-size: 16px; font-weight: 600;">${affiliateData.phone || 'Not provided'}</p>
                        </td>
                        <td width="50%" valign="top" style="padding-bottom: 15px;">
                          <p style="margin: 0 0 5px; font-size: 12px; color: #666; text-transform: uppercase; font-weight: bold;">Website</p>
                          <p style="margin: 0; font-size: 16px; font-weight: 600;">${affiliateData.website || 'Not provided'}</p>
                        </td>
                      </tr>
                      <tr>
                        <td width="50%" valign="top" style="padding-bottom: 15px;">
                          <p style="margin: 0 0 5px; font-size: 12px; color: #666; text-transform: uppercase; font-weight: bold;">User ID</p>
                          <p style="margin: 0; font-size: 16px; font-weight: 600;">${userId}</p>
                        </td>
                        <td width="50%" valign="top" style="padding-bottom: 15px;">
                          <p style="margin: 0 0 5px; font-size: 12px; color: #666; text-transform: uppercase; font-weight: bold;">Registration Date</p>
                          <p style="margin: 0; font-size: 16px; font-weight: 600;">${new Date().toLocaleString()}</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
              
              <p style="margin-bottom: 20px; font-size: 16px; color: #444; line-height: 1.5;">
                The affiliate account has been created and initial referral links have been generated.
              </p>
              
              <div style="text-align: center;">
                <a href="https://kenyaonabudgetsafaris.co.uk/admin/affiliates.html" style="background-color: #e67e22; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: 600; display: inline-block;">View in Admin Panel</a>
              </div>
              
              <!-- System Info -->
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 30px 0 10px; text-align: center; border-top: 1px dashed #e0e0e0;">
                <tr>
                  <td style="padding: 30px 0 10px;">
                    <p style="margin: 0; font-size: 14px; color: #777;">This message was automatically generated by the affiliate system.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 20px; background-color: #f5f5f5; text-align: center; font-size: 14px; color: #666;">
              <p style="margin: 0 0 10px; font-weight: 700; color: #555; font-size: 16px;">KenyaOnABudget Safaris</p>
              <p style="margin: 0 0 10px;">FARINGDON (SN7), SHELLINGFORD, FERNHAM ROAD<br>UNITED KINGDOM</p>
              <p style="margin: 10px 0;">
                Email: <a href="mailto:info@kenyaonabudgetsafaris.co.uk" style="color: #e67e22; text-decoration: none;">info@kenyaonabudgetsafaris.co.uk</a> | 
                Phone: +44 7376 642 148
              </p>
              <p style="margin: 20px 0 0; font-size: 12px; color: #777;">
                &copy; ${new Date().getFullYear()} KenyaOnABudget Safaris. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `;
    
    // Send to all admin emails with our new email function
    for (const adminEmail of CONFIG.ADMIN_EMAILS) {
      await sendEmail(
        adminEmail,
        'New Affiliate Registration - KenyaOnABudget Safaris',
        adminEmailHtml,
        {
          isAdmin: true,
          emailKey: `admin-registration-${userId}-${adminEmail}-${Date.now()}`
        }
      );
    }
  } catch (error) {
    console.error('Error sending welcome emails:', error);
  }
}

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Firebase initialized: ${!!db}`);
  console.log(`Email transport initialized: ${!!transporter}`);
});
