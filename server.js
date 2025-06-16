require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const axios = require('axios');

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
    
    // Send email to affiliate
    if (affiliateData.email) {
      const affiliateEmailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e6e6e6;">
          <div style="background-color: #e67e22; padding: 20px; text-align: center; color: white;">
            <h1 style="margin: 0;">New Commission Earned!</h1>
          </div>
          
          <div style="padding: 20px;">
            <p>Hello ${affiliateData.name || 'Affiliate'},</p>
            
            <p>Great news! You've just earned a commission from a new booking.</p>
            
            <div style="background-color: #f8f8f8; padding: 15px; margin: 20px 0; border-left: 4px solid #e67e22;">
              <p><strong>Package:</strong> ${packageName}</p>
              <p><strong>Booking Amount:</strong> £${formattedPurchase}</p>
              <p><strong>Your Commission (10%):</strong> £${formattedCommission}</p>
              <p><strong>Status:</strong> Pending (will be available after the booking is confirmed)</p>
            </div>
            
            <p>This commission will be added to your affiliate dashboard and will be available for withdrawal once it's confirmed.</p>
            
            <p>Keep up the great work promoting our safaris!</p>
            
            <p style="margin-top: 30px;">
              <a href="https://kenyaonabudgetsafaris.co.uk/affiliate-dashboard.html" style="background-color: #e67e22; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">View Your Dashboard</a>
            </p>
            
            <p style="margin-top: 30px; font-style: italic; color: #666; border-top: 1px solid #eee; padding-top: 15px;">
              Thank you for being a valued affiliate partner of KenyaOnABudget Safaris!
            </p>
          </div>
        </div>
      `;
      
      await transporter.sendMail({
        from: `"Kenya on a Budget Safaris" <${process.env.EMAIL_USER}>`,
        to: affiliateData.email,
        subject: 'New Commission Earned - KenyaOnABudget Safaris',
        html: affiliateEmailHtml
      });
    }
    
    // Send email to admin
    const adminEmailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e6e6e6;">
        <div style="background-color: #e67e22; padding: 20px; text-align: center; color: white;">
          <h1 style="margin: 0;">Affiliate Conversion Alert</h1>
        </div>
        
        <div style="padding: 20px;">
          <p>A new booking has been made through an affiliate link:</p>
          
          <div style="background-color: #f8f8f8; padding: 15px; margin: 20px 0; border-left: 4px solid #e67e22;">
            <p><strong>Affiliate:</strong> ${affiliateData.name} (${affiliateData.email})</p>
            <p><strong>Package:</strong> ${packageName}</p>
            <p><strong>Booking Amount:</strong> £${formattedPurchase}</p>
            <p><strong>Commission (10%):</strong> £${formattedCommission}</p>
            <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
          </div>
          
          <p>This commission is pending and will need to be approved before it becomes available to the affiliate.</p>
          
          <p style="margin-top: 30px;">
            <a href="https://kenyaonabudgetsafaris.co.uk/admin/affiliates.html" style="background-color: #e67e22; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">View in Admin Panel</a>
          </p>
        </div>
      </div>
    `;
    
    // Send to all admin emails
    for (const adminEmail of CONFIG.ADMIN_EMAILS) {
      await transporter.sendMail({
        from: `"Kenya on a Budget Safaris" <${process.env.EMAIL_USER}>`,
        to: adminEmail,
        subject: 'New Affiliate Conversion - KenyaOnABudget Safaris',
        html: adminEmailHtml
      });
    }
  } catch (error) {
    console.error('Error sending conversion emails:', error);
  }
}

async function sendWelcomeEmails(userId, affiliateData, password) {
  try {
    // Generate welcome email content for affiliate
    const passwordSection = password ? `
      <div style="background-color: #f8f8f8; padding: 15px; margin: 20px 0; border-left: 4px solid #e67e22;">
        <p><strong>Your login details:</strong></p>
        <p><strong>Email:</strong> ${affiliateData.email}</p>
        <p><strong>Password:</strong> ${password}</p>
        <p style="color: #e74c3c; font-size: 12px;">Please save this information and change your password after logging in.</p>
      </div>
    ` : '';
    
    const affiliateEmailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e6e6e6;">
        <div style="background-color: #e67e22; padding: 20px; text-align: center; color: white;">
          <h1 style="margin: 0;">Welcome to KenyaOnABudget Affiliate Program!</h1>
        </div>
        
        <div style="padding: 20px;">
          <p>Hello ${affiliateData.name},</p>
          
          <p>Welcome to the KenyaOnABudget Safaris Affiliate Program! We're excited to have you on board.</p>
          
          <p>As our affiliate partner, you'll earn 10% commission on every booking made through your unique referral links.</p>
          
          ${passwordSection}
          
          <h3 style="color: #e67e22; margin-top: 30px;">Getting Started</h3>
          
          <ol>
            <li>Log in to your affiliate dashboard to access your unique referral links</li>
            <li>Share these links on your website, social media, or with your network</li>
            <li>Start earning 10% commission on every booking made through your links</li>
            <li>Track your performance and earnings in real-time from your dashboard</li>
            <li>Request payouts once your balance reaches £${CONFIG.MIN_PAYOUT_AMOUNT}</li>
          </ol>
          
          <p style="margin-top: 30px;">
            <a href="https://kenyaonabudgetsafaris.co.uk/affiliate-dashboard.html" style="background-color: #e67e22; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Access Your Dashboard</a>
          </p>
          
          <p style="margin-top: 30px; font-style: italic; color: #666; border-top: 1px solid #eee; padding-top: 15px;">
            If you have any questions, please don't hesitate to contact us at info@kenyaonabudgetsafaris.co.uk. We're here to help you succeed!
          </p>
        </div>
      </div>
    `;
    
    // Send email to affiliate
    await transporter.sendMail({
      from: `"Kenya on a Budget Safaris" <${process.env.EMAIL_USER}>`,
      to: affiliateData.email,
      subject: 'Welcome to KenyaOnABudget Affiliate Program!',
      html: affiliateEmailHtml
    });
    
    // Send notification to admin
    const adminEmailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e6e6e6;">
        <div style="background-color: #e67e22; padding: 20px; text-align: center; color: white;">
          <h1 style="margin: 0;">New Affiliate Registration</h1>
        </div>
        
        <div style="padding: 20px;">
          <p>A new affiliate has registered on the KenyaOnABudget Safaris website:</p>
          
          <div style="background-color: #f8f8f8; padding: 15px; margin: 20px 0; border-left: 4px solid #e67e22;">
            <p><strong>Name:</strong> ${affiliateData.name}</p>
            <p><strong>Email:</strong> ${affiliateData.email}</p>
            <p><strong>Phone:</strong> ${affiliateData.phone || 'Not provided'}</p>
            <p><strong>Website:</strong> ${affiliateData.website || 'Not provided'}</p>
            <p><strong>Registration Date:</strong> ${new Date().toLocaleString()}</p>
          </div>
          
          <p>The affiliate account has been created and initial referral links have been generated.</p>
          
          <p style="margin-top: 30px;">
            <a href="https://kenyaonabudgetsafaris.co.uk/admin/affiliates.html" style="background-color: #e67e22; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">View in Admin Panel</a>
          </p>
        </div>
      </div>
    `;
    
    // Send to all admin emails
    for (const adminEmail of CONFIG.ADMIN_EMAILS) {
      await transporter.sendMail({
        from: `"Kenya on a Budget Safaris" <${process.env.EMAIL_USER}>`,
        to: adminEmail,
        subject: 'New Affiliate Registration - KenyaOnABudget Safaris',
        html: adminEmailHtml
      });
    }
  } catch (error) {
    console.error('Error sending welcome emails:', error);
  }
}
// For each server, use this endpoint instead
app.get('/ping-status', (req, res) => {
  console.log('Ping-status received at', new Date().toISOString());
  res.status(200).json({ 
    status: 'active', 
    server: 'server-name', // Change to your server name
    timestamp: new Date().toISOString(),
    message: 'Server is running'
  });
});

// And update your ping functions to use this endpoint
async function pingOtherServers() {
  const servers = [
    'https://email-system-9p10.onrender.com',
    'https://affil.onrender.com',
    'https://ping-server.onrender.com'
  ];
  
  // Remove the current server from the list
  const currentServer = 'https://affil.onrender.com'; // Change this
  const serversToContact = servers.filter(s => s !== currentServer);
  
  console.log(`[${new Date().toISOString()}] Starting ping cycle`);
  
  for (const server of serversToContact) {
    try {
      console.log(`Pinging ${server}/ping-status`);
      const response = await axios.get(`${server}/ping-status`, { timeout: 30000 });
      console.log(`Successfully pinged ${server}, status: ${response.status}`);
    } catch (error) {
      let errorMessage = error.message;
      if (error.response) {
        errorMessage = `Status ${error.response.status}: ${error.response.statusText}`;
      }
      console.error(`Error pinging ${server}: ${errorMessage}`);
      
      // Try alternative endpoints
      try {
        console.log(`Trying root URL ${server}`);
        await axios.get(server, { timeout: 10000 });
        console.log(`Successfully reached ${server} root`);
      } catch (rootError) {
        console.error(`Root URL also failed: ${rootError.message}`);
      }
    }
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
