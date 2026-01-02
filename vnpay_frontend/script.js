(function(){
    const backendUrl = 'http://localhost:3000/order/create_payment_url';
    const payBtn = document.getElementById('payBtn');
    const respBox = document.getElementById('response-box');
    const amountInput = document.getElementById('amount');
  
    // Format số tiền khi nhập
    amountInput.addEventListener('input', (e) => {
      let value = e.target.value.replace(/\D/g, '');
      e.target.value = value ? parseInt(value, 10).toLocaleString('en-US') : '';
    });
  
    function setLoading(loading) {
      if (loading) {
        payBtn.classList.add('loading');
        payBtn.disabled = true;
      } else {
        payBtn.classList.remove('loading');
        payBtn.disabled = false;
      }
    }
  
    payBtn.addEventListener('click', async function(){
      const rawAmount = amountInput.value.replace(/,/g, '');
      const amount = Number(rawAmount);
  
      if (!amount || amount < 10000) { 
        respBox.textContent = '⚠️ Số tiền tối thiểu là 10,000 VND';
        respBox.style.color = '#e03c31';
        return; 
      }
  
      const payload = {
        amount: amount,
        bankCode: document.getElementById('bankCode').value || '',
        language: document.getElementById('language').value || 'vn'
      };
  
      setLoading(true);
      respBox.textContent = '🚀 Đang khởi tạo giao dịch...';
      respBox.style.color = '#38bdf8';
  
      try {
        const resp = await axios.post(backendUrl, payload, {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'X-Requested-With': 'XMLHttpRequest'
          }
        });
  
        if (resp.data && resp.data.paymentUrl) {
          respBox.textContent = '✅ Thành công! Đang chuyển hướng đến cổng VNPAY...';
          setTimeout(() => {
            window.location.href = resp.data.paymentUrl;
          }, 800);
          return;
        }
  
        // Check fallback redirect URL
        const finalUrl = resp.request && resp.request.responseURL;
        if (finalUrl && (finalUrl.includes('vnpayment.vn') || finalUrl.includes('vnpay'))) {
          window.location.href = finalUrl;
          return;
        }
  
        respBox.textContent = '❌ Không nhận được URL thanh toán từ Server.';
      } catch (err) {
        console.error(err);
        respBox.textContent = '❌ Lỗi: ' + (err.response?.data?.message || err.message);
      } finally {
        setLoading(false);
      }
    });
  })();