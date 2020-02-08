var socket = io();

socket.on('status', (data) => {
    let element = document.getElementById("status_id");

    element.innerHTML = (data.message ? data.message : '');
    element.style.color = (data.is_error ? 'red' : 'black');
});
